// ADR-0046 — durable task memory. When the warm tier (re)summarises older
// turns at a moved boundary, the messages being evicted have one last
// chance to contribute durable facts to long-term memory before they're
// compressed away. Without this pass, the warm summary keeps re-summarising
// the same key facts every time the boundary moves — they should graduate
// into `memory_store namespace=facts` and stop competing for warm tokens.
//
// This module owns the LLM-driven extraction. The history-window calls it
// once per boundary move, persists high-confidence triples via putMemory,
// and discards the rest. Conservative by design — we'd rather miss a fact
// than store a hallucinated one.

import type { ModelProvider, ProviderMessage, ProviderParams } from "@/lib/providers/types";

export interface ExtractedFact {
  /** Short, snake_case-friendly identifier. Used as the memory_store key. */
  key: string;
  /** Human-readable value the agent will see when this fact is recalled. */
  value: string;
  /** 0..1; we persist only ≥ FACT_CONFIDENCE_THRESHOLD. */
  confidence: number;
}

// Conservative threshold. False negatives (missed facts) are recoverable on
// the next boundary move; false positives (hallucinated facts) corrupt
// memory and are hard to detect later.
export const FACT_CONFIDENCE_THRESHOLD = 0.75;

// Hard cap on output size so a misbehaving model can't drag a giant blob
// into memory_store. ~3KB of well-formed JSON covers many small facts.
const MAX_OUTPUT_CHARS = 3_000;
// Don't ask the model for more than this many candidates per pass — the
// signal-to-noise ratio degrades fast and we'd just be filtering more.
const MAX_FACTS_REQUESTED = 8;

const SYSTEM_PROMPT = [
  "You extract durable facts from conversation transcripts for long-term memory.",
  "",
  "Return ONLY a JSON array of facts. No prose, no preamble, no markdown fence — just the array.",
  "Each fact: { \"key\": \"<short snake_case id>\", \"value\": \"<one sentence>\", \"confidence\": <0..1> }",
  "",
  "Rules:",
  "- ONLY include things that will still be true / relevant on FUTURE turns: user preferences, identifiers (project names, ticket IDs, file paths), decisions, constraints, who-does-what, deadlines.",
  "- DO NOT include transient details (\"the user is currently typing\", \"the agent ran a search\"), interim tool outputs, or anything that's part of completing the task itself.",
  "- DO NOT speculate. If the transcript implies but doesn't state, lower the confidence — and if you can't quote the source line, don't include it at all.",
  "- Keep keys descriptive but short. Examples: deploy_target, preferred_editor, api_base_url.",
  "- Aim for 0–6 high-quality facts. Empty array is a valid response when nothing is durable.",
].join("\n");

function userPrompt(transcript: string): string {
  return [
    `Transcript (older messages being evicted from the hot/warm window):`,
    "",
    transcript,
    "",
    `Return up to ${MAX_FACTS_REQUESTED} durable facts as a JSON array. Empty array if nothing qualifies.`,
  ].join("\n");
}

function messages(transcript: string): ProviderMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt(transcript) },
  ];
}

/**
 * Best-effort extraction. Returns the parsed + filtered fact list, or an
 * empty array on any failure (parse error, model refusal, exhausted retry
 * budget). Failures are logged but never thrown — fact extraction is a
 * "free improvement" pass that must never block the main turn.
 */
export async function extractFactsFromTranscript(
  provider: Pick<ModelProvider, "chat">,
  modelId: string,
  providerParams: ProviderParams,
  transcript: string,
): Promise<ExtractedFact[]> {
  const trimmed = transcript.trim();
  if (!trimmed) return [];

  let raw = "";
  try {
    const { stream } = await provider.chat(modelId, messages(trimmed), {
      ...providerParams,
      // Override max_tokens so the budget calculator's reserve doesn't
      // cap an extraction call at 200 tokens — small but noticeable risk
      // since fact lists with 4-6 entries can exceed that.
      max_tokens: Math.min(1024, typeof providerParams.max_tokens === "number" ? providerParams.max_tokens * 2 : 1024),
    });
    for await (const chunk of stream) {
      raw += chunk;
      if (raw.length > MAX_OUTPUT_CHARS) break; // hard stop on runaway output
    }
  } catch (err) {
    console.warn("[fact-extraction] provider call failed:", err);
    return [];
  }

  return parseFactList(raw).filter((f) => f.confidence >= FACT_CONFIDENCE_THRESHOLD);
}

/**
 * Parse a fact-list response. Tolerates leading/trailing junk by extracting
 * the outermost JSON array via a non-greedy regex; returns [] on any parse
 * failure or shape mismatch. Exported for the test suite.
 */
export function parseFactList(raw: string): ExtractedFact[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // Strip an optional ```json fence the model may add despite the prompt.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : trimmed;

  // Find the outermost array, ignoring any prefix prose. The non-greedy
  // [\s\S]*? matches the minimum to reach the first balanced ].
  const arr = candidate.match(/\[[\s\S]*\]/);
  if (!arr) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(arr[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ExtractedFact[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const key = typeof o.key === "string" ? o.key.trim() : "";
    const value = typeof o.value === "string" ? o.value.trim() : "";
    const confidence = typeof o.confidence === "number" ? o.confidence : NaN;
    if (!key || !value || !Number.isFinite(confidence)) continue;
    if (key.length > 64 || value.length > 400) continue; // reject obviously-runaway entries
    out.push({ key, value, confidence: Math.max(0, Math.min(1, confidence)) });
  }
  return out;
}
