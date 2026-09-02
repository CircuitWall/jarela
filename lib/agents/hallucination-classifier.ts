// Anti-hallucination detector — judges whether an agent turn STALLED,
// meaning the assistant narrated future work but didn't invoke a
// write-class tool to actually do the thing.
//
// Two detection methods, picked by mode (one or the other, never both):
//   "off"   — no detection.
//   "regex" — fast pattern match in lib/agents/run-thread.ts (default).
//   "model" — LLM classifier via this module. Requires a saved model
//             config name; falls back to "regex" if missing.
//
// Per-agent (lib/stores/agent-configs.ts):
//   anti_hallucination_mode + anti_hallucination_model_config
//   NULL on either column → inherit the env defaults below.
//
// Global (lib/env/schema.ts):
//   JARELA_HALLUCINATION_DETECTOR_MODE  = off | regex | model  (default: regex)
//   JARELA_HALLUCINATION_DETECTOR_MODEL = saved model config name
//
// Any invocation error / parse failure / abort returns null so the call
// site can fall back; the classifier never blocks the turn.

import { getProvider } from "@/lib/providers";
import { getModelConfig, getModelParams } from "@/lib/stores/model-config";
import { isWriteLikeToolName } from "@/lib/agents/run-thread";
import { getConfig } from "@/lib/env/config";
import type { AgentConfigRow } from "@/lib/stores/agent-configs";

export type DetectorMode = "off" | "regex" | "model";

export interface ResolvedDetector {
  /** Effective mode after merging the agent override over the env default. */
  mode: DetectorMode;
  /** Effective model config name (only meaningful when mode === "model"). */
  modelConfigName: string;
}

/**
 * Merge the per-agent override (`anti_hallucination_mode` + `_model_config`)
 * over the env default (JARELA_HALLUCINATION_DETECTOR_MODE +
 * JARELA_HALLUCINATION_DETECTOR_MODEL).
 *
 * If the resolved mode is "model" but no model config name is available,
 * silently downgrade to "regex" — this is the cheaper safe fallback. We
 * also downgrade when the named config doesn't exist (typo, deleted
 * config); the call site can log if it cares.
 */
export function resolveDetector(agent: Pick<AgentConfigRow, "anti_hallucination_mode" | "anti_hallucination_model_config"> | null | undefined): ResolvedDetector {
  const env = getConfig();
  const rawMode = (agent?.anti_hallucination_mode as DetectorMode | null | undefined)
    ?? env.hallucinationDetectorMode;
  const modelName = (agent?.anti_hallucination_model_config?.trim() || env.hallucinationDetectorModel.trim());
  if (rawMode === "model" && (!modelName || !getModelConfig(modelName))) {
    // Asked for model classifier but it's not actually configured — fall
    // back to regex so the agent still has SOME guard.
    return { mode: "regex", modelConfigName: "" };
  }
  if (rawMode === "off" || rawMode === "regex" || rawMode === "model") {
    return { mode: rawMode, modelConfigName: modelName };
  }
  return { mode: "regex", modelConfigName: "" };
}

export interface StallVerdict {
  stalled: boolean;
  reason: string;
}

// Keep the prompt tight so a fast model returns in ~1s. We feed only
// the trailing prose (last 1500 chars) — the stall signal is at the end
// of the turn, not in the middle, and longer payloads inflate cost
// without helping accuracy.
const PROMPT_TAIL_BUDGET = 1500;

export const SYSTEM_PROMPT = `You judge whether an agent turn STALLED.

A stalled turn is one where the assistant narrated future work — promised to write/edit/save/update something, said "I'll do X now" or "I'm doing X now" — but did not actually invoke a write-class tool to make the change. Read-only tools (file_read, web_search, list_dir) DO NOT count as fulfilling a write promise.

You will receive: the list of tools the agent called this turn, whether any were write-class, and the trailing prose of the assistant text.

Reply with EXACTLY one JSON object on one line, no surrounding prose, no markdown fence:

{"stalled": true|false, "reason": "<one short sentence, max 120 chars>"}

If the agent called a write-class tool and the prose is consistent with that, stalled=false.
If the prose promises a write but no write-class tool was called, stalled=true.
If the agent's text is a normal completion message ("Here are the results", "Done"), stalled=false even if no write tool was called.`;

export async function classifyStall(
  assistantText: string,
  toolNames: readonly string[],
  modelConfigName: string,
  signal?: AbortSignal,
): Promise<StallVerdict | null> {
  const usedWriteTool = toolNames.some(isWriteLikeToolName);
  if (usedWriteTool) {
    return { stalled: false, reason: "write-class tool called" };
  }

  const cfgName = modelConfigName.trim();
  if (!cfgName) return null;

  const cfg = getModelConfig(cfgName);
  if (!cfg) return null;
  const params = getModelParams(cfg);

  let provider;
  try {
    provider = getProvider(cfg.provider);
  } catch {
    return null;
  }
  if (!provider.invoke) return null;

  const tail = assistantText.slice(-PROMPT_TAIL_BUDGET);
  const userMsg = `Tools called this turn: ${JSON.stringify(toolNames)}
Any write-class tools called? ${usedWriteTool ? "yes" : "no"}

Assistant text (trailing ${tail.length} chars):
${tail}`;

  if (signal?.aborted) return null;

  let result;
  try {
    result = await provider.invoke(
      cfg.model_id,
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
      params,
      [],
    );
  } catch {
    return null;
  }

  const text = result?.text ?? "";
  return parseVerdict(text);
}

// Strict JSON parse — extract the first {...} that looks like a verdict
// and validate fields. Returns null on any parse failure so the caller
// can treat "no opinion" as "fall back to regex".
export function parseVerdict(text: string): StallVerdict | null {
  if (!text) return null;
  // Strip code fences a chatty model might wrap the JSON in.
  const stripped = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  // Find the first balanced-looking object literal.
  const m = /\{[^{}]*"stalled"[^{}]*\}/.exec(stripped);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.stalled !== "boolean") return null;
  const reason = typeof obj.reason === "string" ? obj.reason.slice(0, 200) : "";
  return { stalled: obj.stalled, reason };
}
