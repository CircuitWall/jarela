// Discover a model's context window at save time so the runtime doesn't
// have to guess.
//
// Priority when a user saves a model config without an explicit
// `context_window_tokens`:
//   1. provider.listModels(params) — live API catalog value, if the
//      provider adapter implements listModels and returns a matching
//      row with a numeric context_length.
//   2. getKnownContextLength(provider, model_id) — hand-curated static
//      table (lib/providers/known-context-windows.ts).
//   3. null — caller keeps the value unset; runtime falls back to
//      DEFAULT_CONTEXT_WINDOW_TOKENS (8192) until a context-overflow
//      error triggers the halve-and-persist self-correct in llm.ts.
//
// Never throws — a discovery failure returns null so save doesn't block
// on a flaky /models endpoint. See ADR-0067.

import { getProvider } from "@/lib/providers";
import { getKnownContextLength } from "@/lib/providers/known-context-windows";
import type { ProviderParams } from "@/lib/providers/types";

export async function discoverContextWindow(
  provider: string,
  model_id: string,
  params: ProviderParams,
): Promise<number | null> {
  if (!provider || !model_id) return null;

  try {
    const p = getProvider(provider);
    if (p.listModels) {
      const catalog = await p.listModels(params);
      const hit = pickCatalogHit(catalog, model_id);
      if (hit && typeof hit.context_length === "number" && hit.context_length > 0) {
        return Math.floor(hit.context_length);
      }
    }
  } catch (err) {
    console.warn(
      `[discover-ctx] listModels failed for ${provider}/${model_id}, falling back to static table:`,
      (err as Error).message,
    );
  }

  return getKnownContextLength(provider, model_id);
}

interface CatalogRow { id: string; context_length: number | null }

// Providers may list the model under a versioned or aliased id
// (e.g. "gpt-4o-2024-08-06" vs user's "gpt-4o"). Try exact first,
// then longest-prefix, then longest-substring, all lowercased.
function pickCatalogHit(catalog: CatalogRow[], model_id: string): CatalogRow | null {
  const lower = model_id.toLowerCase();
  const exact = catalog.find((m) => m.id.toLowerCase() === lower);
  if (exact) return exact;
  let bestPrefix: CatalogRow | null = null;
  let bestPrefixLen = 0;
  for (const m of catalog) {
    const id = m.id.toLowerCase();
    if (id.startsWith(lower) && lower.length > bestPrefixLen) {
      bestPrefix = m;
      bestPrefixLen = lower.length;
    }
    if (lower.startsWith(id) && id.length > bestPrefixLen) {
      bestPrefix = m;
      bestPrefixLen = id.length;
    }
  }
  return bestPrefix;
}

/**
 * Merge a discovered `context_window_tokens` into a params object when
 * the user didn't set one explicitly. Non-destructive: returns the same
 * object reference (unchanged) if params already carry a positive value.
 */
export async function enrichParamsWithDiscoveredContext(
  provider: string,
  model_id: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const explicit = params.context_window_tokens;
  if (typeof explicit === "number" && explicit > 0) return params;

  const discovered = await discoverContextWindow(
    provider,
    model_id,
    params as ProviderParams,
  );
  if (discovered && discovered > 0) {
    return { ...params, context_window_tokens: discovered };
  }
  return params;
}
