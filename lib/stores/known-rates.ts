// Authoritative published per-1M-token rates for canonical model ids.
//
// Used by `modelRatesFor` as the FINAL fallback after the live snapshot
// lookup chain. The snapshot extractor can break when a provider redesigns
// its pricing page (regex window misses the model name, LLM extraction
// returns uniform garbage); without a baseline, the dashboard cost columns
// silently go to null on the most-used models. This table guarantees a
// non-null rate for the canonical ids regardless of snapshot health.
//
// **These rates ARE stale by construction.** Bump manually when a provider
// updates published pricing. The live snapshot — when healthy — wins; this
// is only consulted when nothing else matched. Confidence is reported as
// "medium" so the dashboard's data-quality chip flags it as not-the-source-
// of-truth.
//
// Keep the list short. Only include canonical ids the snapshot extractor
// reliably struggles with. Aliases handled by `modelAliasCandidates` (e.g.
// the post-`/` suffix of `openai/gpt-4o`) so we don't need separate entries
// for aggregator-namespaced ids.
//
// Sources, last verified 2026-06:
//   - https://www.anthropic.com/pricing
//   - https://openai.com/api/pricing/
//   - https://ai.google.dev/gemini-api/docs/pricing
//   - https://platform.deepseek.com/pricing

import type { ProviderRates } from "./pricing";

interface KnownRate {
  inputPer1M: number;
  outputPer1M: number;
}

const KNOWN_MODEL_RATES: Record<string, KnownRate> = {
  // Anthropic
  "claude-opus-4-7": { inputPer1M: 15, outputPer1M: 75 },
  "claude-opus-4-6": { inputPer1M: 15, outputPer1M: 75 },
  "claude-opus-4-5": { inputPer1M: 15, outputPer1M: 75 },
  "claude-opus-4": { inputPer1M: 15, outputPer1M: 75 },
  "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
  "claude-sonnet-4-5": { inputPer1M: 3, outputPer1M: 15 },
  "claude-sonnet-4": { inputPer1M: 3, outputPer1M: 15 },
  "claude-haiku-4-5": { inputPer1M: 1, outputPer1M: 5 },
  "claude-3-5-sonnet": { inputPer1M: 3, outputPer1M: 15 },
  "claude-3-5-haiku": { inputPer1M: 0.8, outputPer1M: 4 },
  "claude-3-opus": { inputPer1M: 15, outputPer1M: 75 },
  "claude-3-sonnet": { inputPer1M: 3, outputPer1M: 15 },
  "claude-3-haiku": { inputPer1M: 0.25, outputPer1M: 1.25 },

  // OpenAI
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4-turbo": { inputPer1M: 10, outputPer1M: 30 },
  "gpt-4": { inputPer1M: 30, outputPer1M: 60 },
  "gpt-3.5-turbo": { inputPer1M: 0.5, outputPer1M: 1.5 },
  "o1": { inputPer1M: 15, outputPer1M: 60 },
  "o1-mini": { inputPer1M: 3, outputPer1M: 12 },
  "o1-preview": { inputPer1M: 15, outputPer1M: 60 },
  "o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },

  // Google Gemini
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 5 },
  "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5 },
  "gemini-2.5-flash-lite": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gemini-2.0-flash-lite": { inputPer1M: 0.075, outputPer1M: 0.3 },
  "gemini-1.5-pro": { inputPer1M: 1.25, outputPer1M: 5 },
  "gemini-1.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },

  // DeepSeek
  "deepseek-chat": { inputPer1M: 0.27, outputPer1M: 1.10 },
  "deepseek-reasoner": { inputPer1M: 0.55, outputPer1M: 2.19 },
  "deepseek-coder": { inputPer1M: 0.27, outputPer1M: 1.10 },

  // Cohere
  "command-r-plus": { inputPer1M: 2.5, outputPer1M: 10 },
  "command-r": { inputPer1M: 0.15, outputPer1M: 0.6 },
};

export function knownRateFor(modelId: string): ProviderRates | null {
  const key = modelId.trim().toLowerCase();
  if (!key) return null;
  const hit = KNOWN_MODEL_RATES[key];
  if (!hit) return null;
  return {
    inputPer1M: hit.inputPer1M,
    outputPer1M: hit.outputPer1M,
    source: "jarela:known-rates",
    inferred: false,
    confidence: "medium",
    ok: true,
    status: null,
    error: null,
  };
}
