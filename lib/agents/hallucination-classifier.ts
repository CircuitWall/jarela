// Anti-hallucination classifier (configurable model) — judges whether an
// agent turn STALLED, meaning the assistant narrated future work but
// didn't invoke a write-class tool to actually do the thing.
//
// Two knobs in lib/env/schema.ts drive this:
//   JARELA_HALLUCINATION_DETECTOR_MODE  = off | report | enforce
//   JARELA_HALLUCINATION_DETECTOR_MODEL = name of a saved model config
//
// `off`     — never invoked.
// `report`  — runs in parallel with the regex; on disagreement, logs a
//             structured entry to the logs sink (greppable in the panel)
//             and the call site appends a footer note.
// `enforce` — classifier vote OR regex vote → triggers retry.
//
// Empty model name short-circuits to mode=off regardless. Same for any
// invocation error: the classifier is best-effort, never blocks the turn.

import { getProvider } from "@/lib/providers";
import { getModelConfig, getModelParams } from "@/lib/stores/model-config";
import { isWriteLikeToolName } from "@/lib/agents/run-thread";

export interface StallVerdict {
  stalled: boolean;
  reason: string;
}

// Keep the prompt tight so a fast model returns in ~1s. We feed only
// the trailing prose (last 1500 chars) — the stall signal is at the end
// of the turn, not in the middle, and longer payloads inflate cost
// without helping accuracy.
const PROMPT_TAIL_BUDGET = 1500;

const SYSTEM_PROMPT = `You judge whether an agent turn STALLED.

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

  const usedWriteTool = toolNames.some(isWriteLikeToolName);
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
