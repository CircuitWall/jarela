/**
 * Static per-provider classification of which model ids accept image inputs.
 *
 * Used purely to surface UI hints — "this agent's model can read WhatsApp
 * images" — so a user can pick a vision-capable model BEFORE pointing a
 * bridge route at an agent. The runtime never enforces this: the bridge
 * always forwards whatever payload it captured, and the provider returns
 * whatever ignore/error behaviour the upstream model chose if it isn't
 * actually multi-modal.
 *
 * Patterns intentionally err on the *generous* side. A false positive just
 * means the user sees no warning for a model that quietly ignores images;
 * a false negative would mean users see a scary warning on a model that
 * actually works fine. We update the patterns as new model families ship.
 *
 * NOTE: this module is intentionally free of server-only imports so the
 * BridgeEditor / AgentEditor UIs can import it directly.
 */

const PATTERNS: Record<string, RegExp[]> = {
  // OpenAI — every modern flagship is multi-modal; only the legacy
  // gpt-3.5-* / text-davinci-* / o3-mini-text family stay text-only.
  openai: [
    /^gpt-4o/i,
    /^gpt-4\.1/i,
    /^gpt-4-turbo/i,
    /^gpt-4-vision/i,
    /^gpt-5/i,
    /^chatgpt-4o/i,
    /^o[134](?:-|$)/i, // o1, o3, o4-mini (vision-enabled reasoning models)
  ],
  // Anthropic — Claude 3 onwards is vision-native across all tiers.
  anthropic: [
    /^claude-3/i,
    /^claude-sonnet/i,
    /^claude-opus/i,
    /^claude-haiku-4/i,
    /^claude-[45](?:-|$)/i,
  ],
  // Google — Gemini 1.5+ are multi-modal; legacy gemini-pro is text-only,
  // but gemini-pro-vision was the explicit vision SKU before 1.5.
  gemini: [/^gemini-(1\.5|2|3)/i, /^gemini-pro-vision/i],
  // GitHub Copilot — proxies vision-capable models from OpenAI / Anthropic /
  // Google. Mirror those families (the actual capability is gated server-
  // side by Copilot; we just don't warn).
  "github-copilot": [
    /^gpt-4o/i,
    /^gpt-4\.1/i,
    /^gpt-5/i,
    /^o[134](?:-|$)/i,
    /^claude-3/i,
    /^claude-sonnet/i,
    /^claude-opus/i,
    /^claude-haiku-4/i,
    /^claude-[45](?:-|$)/i,
    /^gemini-(1\.5|2|3)/i,
  ],
  // DeepSeek / Cohere — current public chat SKUs are text-only.
  deepseek: [],
  cohere: [],
  // LangChain pass-through could be anything; treat as unknown (handled
  // separately below) rather than yes/no.
  langchain: [],
  // Tests assume the mock accepts images.
  mock: [/.*/],
};

/**
 * Returns true when the given (provider, model_id) pair is known to accept
 * image inputs. Unknown providers / models return false — call
 * `isProviderClassified` if you want to distinguish "definitely no" from
 * "we don't recognize this".
 */
export function modelSupportsImages(provider: string, modelId: string): boolean {
  const pats = PATTERNS[provider.toLowerCase()] ?? [];
  return pats.some((re) => re.test(modelId));
}

/**
 * True when we have an explicit capability list for the provider. Used by
 * the UI to soften the warning copy ("might not support images") for
 * pass-through providers like `langchain` or unknown external ones.
 */
export function isProviderClassified(provider: string): boolean {
  return provider.toLowerCase() in PATTERNS;
}

// ── extended capabilities for badge rendering ────────────────────────────────
// Mirrors CatalogModel["capabilities"] so saved ModelConfigs can render the
// same icon set the catalog browser uses. Heuristics err on the conservative
// side for audio (vanilla gpt-4o is NOT audio-capable — only *-audio-preview /
// *-realtime are) and generous side for files (PDF / document input).

const AUDIO_PATTERNS: Record<string, RegExp[]> = {
  openai: [/audio/i, /realtime/i],
  gemini: [/^gemini-(1\.5|2|3)/i],
  anthropic: [],
  "github-copilot": [/audio/i, /realtime/i, /^gemini-(1\.5|2|3)/i],
  deepseek: [],
  cohere: [],
  langchain: [],
  mock: [/.*/],
};

const FILES_PATTERNS: Record<string, RegExp[]> = {
  // PDF / document upload support.
  openai: [/^gpt-4o/i, /^gpt-4\.1/i, /^gpt-4-turbo/i, /^gpt-5/i, /^o[134](?:-|$)/i, /^chatgpt-4o/i],
  anthropic: [/^claude-3/i, /^claude-sonnet/i, /^claude-opus/i, /^claude-haiku-4/i, /^claude-[45](?:-|$)/i],
  gemini: [/^gemini-(1\.5|2|3)/i],
  "github-copilot": [/^gpt-4o/i, /^gpt-4\.1/i, /^gpt-5/i, /^o[134](?:-|$)/i, /^claude-3/i, /^claude-sonnet/i, /^claude-opus/i, /^claude-haiku-4/i, /^claude-[45](?:-|$)/i, /^gemini-(1\.5|2|3)/i],
  deepseek: [],
  cohere: [],
  langchain: [],
  mock: [/.*/],
};

const WEB_SEARCH_PATTERNS: Record<string, RegExp[]> = {
  // Built-in provider-side web tool.
  anthropic: [/^claude-3\.5/i, /^claude-3\.7/i, /^claude-sonnet/i, /^claude-opus/i, /^claude-haiku-4/i, /^claude-[45](?:-|$)/i],
  openai: [],
  gemini: [],
  "github-copilot": [],
  deepseek: [],
  cohere: [],
  langchain: [],
  mock: [],
};

const JSON_MODE_PROVIDERS = new Set(["openai", "gemini", "deepseek", "mock"]);

function matchesAny(map: Record<string, RegExp[]>, provider: string, modelId: string): boolean {
  const pats = map[provider.toLowerCase()] ?? [];
  return pats.some((re) => re.test(modelId));
}

export interface ModelCapabilities {
  vision: boolean;
  tools: boolean;
  streaming: boolean;
  json_mode: boolean;
  web_search: boolean;
  audio: boolean;
  files: boolean;
}

/**
 * Best-effort capability inference for a saved (provider, model_id) pair —
 * used to render capability badges in surfaces that don't have a live
 * catalog fetch (ModelsPanel, AgentEditor dropdowns, etc.).
 */
export function modelCapabilities(provider: string, modelId: string): ModelCapabilities {
  const p = provider.toLowerCase();
  // Reasoner-style models that don't expose tool calling.
  const noTools = /^deepseek-reasoner/i.test(modelId);
  return {
    vision: modelSupportsImages(provider, modelId),
    tools: isProviderClassified(p) && !noTools,
    streaming: true,
    json_mode: JSON_MODE_PROVIDERS.has(p),
    web_search: matchesAny(WEB_SEARCH_PATTERNS, provider, modelId),
    audio: matchesAny(AUDIO_PATTERNS, provider, modelId),
    files: matchesAny(FILES_PATTERNS, provider, modelId),
  };
}
