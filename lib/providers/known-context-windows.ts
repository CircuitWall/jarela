// Web-sourced fallback context-window sizes per (provider, model_id).
// Used when the live `/models` endpoint doesn't report `context_length`
// (OpenAI's catalog and GitHub Copilot's catalog both omit it) AND the
// user hasn't pinned `context_window_tokens` on the model config.
//
// Resolution order at runtime is:
//   1. user-set `params.context_window_tokens` (explicit override)
//   2. live API value via `listModels()` / catalog cache (when populated)
//   3. this static fallback (this file)
//   4. `DEFAULT_CONTEXT_WINDOW_TOKENS` in lib/agents/context-budget.ts
//
// Verified from each vendor's public docs as of 2026-06. Bump when vendors
// publish new families.

export interface KnownModelLimits {
  context_length: number;
  max_output_tokens?: number;
}

const ANTHROPIC: Record<string, KnownModelLimits> = {
  "claude-opus-4-7": { context_length: 1_000_000, max_output_tokens: 8192 },
  "claude-opus-4": { context_length: 200_000, max_output_tokens: 8192 },
  "claude-sonnet-4-6": { context_length: 200_000, max_output_tokens: 8192 },
  "claude-sonnet-4": { context_length: 200_000, max_output_tokens: 8192 },
  "claude-3.7-sonnet": { context_length: 200_000, max_output_tokens: 8192 },
  "claude-3-7-sonnet": { context_length: 200_000, max_output_tokens: 8192 },
  "claude-3-5-sonnet": { context_length: 200_000, max_output_tokens: 8192 },
  "claude-3-5-haiku": { context_length: 200_000, max_output_tokens: 8192 },
  "claude-haiku-4-5": { context_length: 200_000, max_output_tokens: 4096 },
  "claude-haiku-4": { context_length: 200_000, max_output_tokens: 4096 },
  "claude-3-opus": { context_length: 200_000, max_output_tokens: 4096 },
};

const GEMINI: Record<string, KnownModelLimits> = {
  "gemini-2.5-pro": { context_length: 1_048_576, max_output_tokens: 65_536 },
  "gemini-2.5-flash": { context_length: 1_048_576, max_output_tokens: 65_536 },
  "gemini-2.0-flash-lite": { context_length: 1_048_576, max_output_tokens: 8192 },
  "gemini-2.0-flash": { context_length: 1_048_576, max_output_tokens: 8192 },
  "gemini-1.5-pro": { context_length: 2_097_152, max_output_tokens: 8192 },
  "gemini-1.5-flash": { context_length: 1_048_576, max_output_tokens: 8192 },
};

const OPENAI: Record<string, KnownModelLimits> = {
  "gpt-5-mini": { context_length: 400_000, max_output_tokens: 128_000 },
  "gpt-5": { context_length: 400_000, max_output_tokens: 128_000 },
  "gpt-4.1-mini": { context_length: 1_047_576, max_output_tokens: 32_768 },
  "gpt-4.1": { context_length: 1_047_576, max_output_tokens: 32_768 },
  "gpt-4o-mini": { context_length: 128_000, max_output_tokens: 16_384 },
  "gpt-4o": { context_length: 128_000, max_output_tokens: 16_384 },
  "gpt-4-turbo": { context_length: 128_000, max_output_tokens: 4096 },
  "gpt-4": { context_length: 8192, max_output_tokens: 4096 },
  "gpt-3.5-turbo": { context_length: 16_385, max_output_tokens: 4096 },
  "chatgpt-4o": { context_length: 128_000, max_output_tokens: 16_384 },
  "o4-mini": { context_length: 200_000, max_output_tokens: 100_000 },
  "o3-mini": { context_length: 200_000, max_output_tokens: 100_000 },
  "o3": { context_length: 200_000, max_output_tokens: 100_000 },
  "o1-mini": { context_length: 128_000, max_output_tokens: 65_536 },
  "o1": { context_length: 200_000, max_output_tokens: 100_000 },
};

const DEEPSEEK: Record<string, KnownModelLimits> = {
  "deepseek-v4-flash": { context_length: 65_536, max_output_tokens: 8192 },
  "deepseek-v4-pro": { context_length: 65_536, max_output_tokens: 8192 },
  "deepseek-chat": { context_length: 65_536, max_output_tokens: 8192 },
  "deepseek-reasoner": { context_length: 65_536, max_output_tokens: 8192 },
};

// GitHub Copilot proxies vendor models — sometimes under a transformed id
// (e.g. `Github-Opus4.6`, `copilot-claude-3.5-sonnet`). Strip the proxy
// prefix and dispatch to the underlying vendor table.
function resolveCopilot(model_id: string): KnownModelLimits | null {
  const normalized = model_id
    .replace(/^(?:Github-|copilot-)/i, "")
    .toLowerCase();
  // Canonicalise a few proxy-specific spellings.
  const canon = normalized
    .replace(/^opus4\.6/, "claude-opus-4-7")
    .replace(/^opus4/, "claude-opus-4")
    .replace(/^sonnet4\.6/, "claude-sonnet-4-6")
    .replace(/^sonnet4/, "claude-sonnet-4")
    .replace(/^haiku4\.5/, "claude-haiku-4-5");
  if (canon.startsWith("claude")) return matchPrefix(ANTHROPIC, canon);
  if (canon.startsWith("gemini")) return matchPrefix(GEMINI, canon);
  if (canon.startsWith("gpt") || /^o[134](?:-|$)/.test(canon)) return matchPrefix(OPENAI, canon);
  return null;
}

function matchPrefix(table: Record<string, KnownModelLimits>, id: string): KnownModelLimits | null {
  const lower = id.toLowerCase();
  const exact = table[lower];
  if (exact) return exact;
  // Longest-prefix match so `gpt-4o-2024-08-06` resolves to `gpt-4o` and
  // not `gpt-4` (which would also prefix-match).
  let best: { key: string; v: KnownModelLimits } | null = null;
  for (const [k, v] of Object.entries(table)) {
    if (lower.startsWith(k) && (!best || k.length > best.key.length)) {
      best = { key: k, v };
    }
  }
  return best?.v ?? null;
}

export function getKnownModelLimits(provider: string, model_id: string): KnownModelLimits | null {
  if (!provider || !model_id) return null;
  switch (provider) {
    case "anthropic": return matchPrefix(ANTHROPIC, model_id);
    case "gemini": return matchPrefix(GEMINI, model_id);
    case "openai": return matchPrefix(OPENAI, model_id);
    case "deepseek": return matchPrefix(DEEPSEEK, model_id);
    case "github-copilot": return resolveCopilot(model_id);
    default: return null;
  }
}

export function getKnownContextLength(provider: string, model_id: string): number | null {
  return getKnownModelLimits(provider, model_id)?.context_length ?? null;
}

export function getKnownMaxOutputTokens(provider: string, model_id: string): number | null {
  return getKnownModelLimits(provider, model_id)?.max_output_tokens ?? null;
}
