// Group a flat list of tool names (or tool objects) by the third-party
// provider each one belongs to. Providers are detected from the tool's
// underscore-separated name via `brandSlugForToolName` — the same helper
// the model provider surface uses to render brand marks. Tools whose
// prefix doesn't match a known provider fall into an "Other" bucket.
//
// Used by both the Tools panel (built-in category rows) and the agent-
// permissions editor to break wide categories like "Mail" into visually
// distinct provider boxes (Gmail / Outlook / iCloud / Other).

import { brandSlugForToolName } from "@/components/models/ProviderLogo";

export const OTHER_PROVIDER_KEY = "__other__";

/**
 * Display labels for provider slugs. Missing slugs fall back to the raw
 * slug title-cased. Keep in sync with `KNOWN_BRAND_SLUGS` in
 * `components/models/ProviderLogo.tsx` — new brands added there should
 * gain a label here so the header reads nicely.
 */
export const PROVIDER_LABELS: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  icloud: "iCloud",
  google: "Google",
  gemini: "Gemini",
  github: "GitHub",
  "github-copilot": "GitHub",
  atlassian: "Atlassian",
  jira: "Jira",
  jira_align: "Jira Align",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  signal: "Signal",
  messenger: "Messenger",
  discord: "Discord",
  anthropic: "Anthropic",
  openai: "OpenAI",
  cohere: "Cohere",
  perplexity: "Perplexity",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  ollama: "Ollama",
  langchain: "LangChain",
  xai: "xAI",
  grok: "Grok",
  microsoft: "Microsoft",
};

/** Slug returned when the tool name doesn't match any known brand prefix. */
export function providerForToolName(name: string): string {
  return brandSlugForToolName(name) ?? OTHER_PROVIDER_KEY;
}

export function labelForProvider(slug: string): string {
  if (slug === OTHER_PROVIDER_KEY) return "Other";
  if (PROVIDER_LABELS[slug]) return PROVIDER_LABELS[slug];
  // Fallback: title-case the slug (`some_thing` -> `Some Thing`).
  return slug
    .split(/[_\-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface ProviderGroup<T> {
  /** Provider slug (`gmail`, `outlook`, ...) or `OTHER_PROVIDER_KEY`. */
  provider: string;
  /** Human-readable display label (`Gmail`, `Other`, ...). */
  label: string;
  items: T[];
}

/**
 * Group items by provider, derived from `getName(item)`. Provider order
 * follows first appearance in the input except that the "Other" bucket
 * is always appended last (empty groups are omitted). Stable within each
 * group — items keep their original relative order.
 */
export function groupByProvider<T>(
  items: readonly T[],
  getName: (item: T) => string,
): ProviderGroup<T>[] {
  const buckets = new Map<string, T[]>();
  const order: string[] = [];
  for (const item of items) {
    const slug = providerForToolName(getName(item));
    let list = buckets.get(slug);
    if (!list) {
      list = [];
      buckets.set(slug, list);
      order.push(slug);
    }
    list.push(item);
  }
  // Move OTHER to the end so it always renders last.
  const otherIdx = order.indexOf(OTHER_PROVIDER_KEY);
  if (otherIdx !== -1 && otherIdx !== order.length - 1) {
    order.splice(otherIdx, 1);
    order.push(OTHER_PROVIDER_KEY);
  }
  return order.map((slug) => ({
    provider: slug,
    label: labelForProvider(slug),
    items: buckets.get(slug)!,
  }));
}
