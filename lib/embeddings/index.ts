import { getProvider } from "@/lib/providers";
import { getModelConfig, getDefaultModelConfig, listModelConfigs, type ModelConfigRow } from "@/lib/stores/model-config";
import { getDb } from "@/lib/db";
import { SENSITIVE_MEMORY_NAMESPACES } from "@/lib/crypto/sensitive";
import type { ProviderParams } from "@/lib/providers/types";

// Sensitive namespaces (ADR-0005) are never surfaced via recall: their
// values are encrypted at rest, and credentials should not reach agent
// context via semantic search regardless.
const EXCLUDED_NS = [...SENSITIVE_MEMORY_NAMESPACES];
const EXCLUDED_NS_PLACEHOLDERS = EXCLUDED_NS.map(() => "?").join(",");

// Embedding model resolution:
// 1. EMBEDDING_MODEL_CONFIG env var → name of a row in model_configs
// 2. Else: same provider as the default chat model + a sane default model_id
//    (text-embedding-3-small for OpenAI-compatible providers).
// Embedding generation is best-effort: any failure returns null and the caller
// falls back to substring search.
async function resolveEmbeddingClient(): Promise<{
  provider: ReturnType<typeof getProvider>;
  modelId: string;
  params: ProviderParams;
} | null> {
  function fromConfig(cfg: ModelConfigRow | null): {
    provider: ReturnType<typeof getProvider>;
    modelId: string;
    params: ProviderParams;
  } | null {
    if (!cfg) return null;
    let params: ProviderParams;
    try { params = JSON.parse(cfg.params) as ProviderParams; } catch { return null; }
    const provider = getProvider(cfg.provider);
    if (!provider.embed) return null;
    // Default to a small embedding model for the OpenAI-compatible providers if
    // the chat model_id was used (e.g. "gpt-4o", "claude-..."). Override via
    // params.embedding_model_id.
    const overridden = (params as Record<string, unknown>).embedding_model_id;
    const modelId = typeof overridden === "string" && overridden
      ? overridden
      : isChatModelId(cfg.model_id)
        ? "text-embedding-3-small"
        : cfg.model_id;
    return { provider, modelId, params };
  }

  const explicitName = process.env.EMBEDDING_MODEL_CONFIG;
  // 1) explicit embedding model name (if provided).
  if (explicitName) {
    const explicit = fromConfig(getModelConfig(explicitName));
    if (explicit) return explicit;
  }

  // 2) default chat model if it also supports embeddings.
  const fromDefault = fromConfig(getDefaultModelConfig());
  if (fromDefault) return fromDefault;

  // 3) installation-safe fallback: any configured model with embed support.
  // This avoids "silent 0 embeddings forever" when default chat provider
  // (e.g. github-copilot) has no embed API but another model is configured.
  const configs = listModelConfigs();
  for (const cfg of configs) {
    if (explicitName && cfg.name === explicitName) continue;
    const candidate = fromConfig(cfg);
    if (candidate) return candidate;
  }
  return null;
}

function isChatModelId(id: string): boolean {
  return /^(gpt-|claude-|deepseek-chat|deepseek-reasoner)/.test(id);
}

export async function embed(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  const client = await resolveEmbeddingClient();
  if (!client) return null;
  try {
    return await client.provider.embed!(client.modelId, texts, client.params);
  } catch (err) {
    console.warn("[embeddings] failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function embedOne(text: string): Promise<number[] | null> {
  const out = await embed([text]);
  return out?.[0] ?? null;
}

// HTTP status / error message → "should we retry?"
// 429 = rate limit, 5xx = transient server, plus a small set of node fetch
// codes that show up under load. Anything else is a real config / input
// problem that retrying won't fix.
const TRANSIENT_RE = /\b(429|5\d\d|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_(SOCKET|CONNECT_TIMEOUT)|fetch failed)\b/;
function isTransient(err: unknown): boolean {
  return TRANSIENT_RE.test(err instanceof Error ? err.message : String(err));
}

async function callEmbedWithRetry(
  client: { provider: ReturnType<typeof getProvider>; modelId: string; params: ProviderParams },
  texts: string[],
): Promise<number[][]> {
  // 250ms → 1s → 4s. Three attempts is enough to ride through a brief
  // rate-limit blip without dragging out a whole reindex run.
  const backoffs = [250, 1000, 4000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await client.provider.embed!(client.modelId, texts, client.params);
    } catch (err) {
      lastErr = err;
      if (attempt >= backoffs.length || !isTransient(err)) break;
      await new Promise((r) => setTimeout(r, backoffs[attempt]));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface EmbedBestEffortResult {
  /** One slot per input text. `null` means embedding failed for that input. */
  vectors: (number[] | null)[];
  /** First error message seen, useful for surfacing on the source row. */
  error: string | null;
  /** Count of inputs that didn't get a vector. */
  failed: number;
}

/**
 * Like `embed()` but resilient: retries transient errors (429/5xx) with
 * exponential backoff, then on persistent failure splits the batch in half
 * and recurses, so one bad input doesn't lose embeddings for every other
 * chunk in the same document.
 *
 * Returns per-input results so the caller can persist whichever vectors
 * came back and report an aggregate count of failures up to the source
 * row instead of swallowing the error.
 */
export async function embedBestEffort(texts: string[]): Promise<EmbedBestEffortResult> {
  if (texts.length === 0) return { vectors: [], error: null, failed: 0 };
  const client = await resolveEmbeddingClient();
  if (!client) {
    return {
      vectors: texts.map(() => null),
      error: "no embedding provider configured",
      failed: texts.length,
    };
  }
  return embedBestEffortInternal(client, texts);
}

async function embedBestEffortInternal(
  client: { provider: ReturnType<typeof getProvider>; modelId: string; params: ProviderParams },
  texts: string[],
): Promise<EmbedBestEffortResult> {
  try {
    const vectors = await callEmbedWithRetry(client, texts);
    if (vectors.length === texts.length) return { vectors, error: null, failed: 0 };
    // Provider returned a short array — pad with nulls so indices line up.
    const padded: (number[] | null)[] = texts.map((_, i) => vectors[i] ?? null);
    const failed = padded.filter((v) => v === null).length;
    return {
      vectors: padded,
      error: `embedding provider returned ${vectors.length}/${texts.length} vectors`,
      failed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (texts.length === 1) {
      console.warn("[embeddings] failed:", msg);
      return { vectors: [null], error: msg, failed: 1 };
    }
    // Halve and recurse: a single oversized input shouldn't poison its
    // batchmates. The two halves run sequentially because the typical
    // failure (rate limit) doesn't get better by parallelising.
    const mid = Math.floor(texts.length / 2);
    const left = await embedBestEffortInternal(client, texts.slice(0, mid));
    const right = await embedBestEffortInternal(client, texts.slice(mid));
    return {
      vectors: [...left.vectors, ...right.vectors],
      error: left.error ?? right.error,
      failed: left.failed + right.failed,
    };
  }
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface RecalledMemory {
  source: "memory" | "message";
  namespace?: string;
  key?: string;
  thread_id?: string;
  role?: string;
  content: string;
  score: number;
  created_at: string;
}

// Cross-source recall: compares the query embedding against every memory entry
// and chat message that has an embedding. Returns top-k by cosine. Falls back
// to a recent-rows substring scan for entries that don't have an embedding yet
// (write-then-immediate-query case where the async embed hasn't landed).
export async function recall(query: string, limit = 5): Promise<RecalledMemory[]> {
  const qVec = await embedOne(query);
  const db = getDb();
  const scored: RecalledMemory[] = [];

  // ── semantic pass ─────────────────────────────────────────────────────────
  if (qVec) {
    const memRows = db.prepare(
      // Exclude sensitive namespaces (ADR-0005) — encrypted blobs would
      // surface as enc:v1:… strings and credentials should never reach
      // the agent context via recall regardless.
      `SELECT namespace, key, value, embedding, created_at FROM memory_store
        WHERE embedding IS NOT NULL AND namespace NOT IN (${EXCLUDED_NS_PLACEHOLDERS})`,
    ).all(...EXCLUDED_NS) as Array<{ namespace: string; key: string; value: string; embedding: string; created_at: string }>;

    const msgRows = db.prepare(
      "SELECT thread_id, role, content, embedding, created_at FROM messages WHERE embedding IS NOT NULL",
    ).all() as Array<{ thread_id: string; role: string; content: string; embedding: string; created_at: string }>;

    for (const r of memRows) {
      const v = parseEmbedding(r.embedding);
      if (!v) continue;
      scored.push({
        source: "memory", namespace: r.namespace, key: r.key,
        content: r.value, score: cosine(qVec, v), created_at: r.created_at,
      });
    }
    for (const r of msgRows) {
      const v = parseEmbedding(r.embedding);
      if (!v) continue;
      scored.push({
        source: "message", thread_id: r.thread_id, role: r.role,
        content: r.content, score: cosine(qVec, v), created_at: r.created_at,
      });
    }
  }

  // ── unembedded fallback: keyword overlap on rows still pending embedding ─
  // This catches the write-then-immediately-query case where async embed
  // hasn't completed. Score is capped below the embedding floor so a real
  // semantic match always wins.
  const tokens = tokenize(query);
  if (tokens.length > 0) {
    const recentMem = db.prepare(
      `SELECT namespace, key, value, created_at FROM memory_store
        WHERE embedding IS NULL AND namespace NOT IN (${EXCLUDED_NS_PLACEHOLDERS})
        ORDER BY updated_at DESC LIMIT 50`,
    ).all(...EXCLUDED_NS) as Array<{ namespace: string; key: string; value: string; created_at: string }>;
    const recentMsg = db.prepare(
      "SELECT thread_id, role, content, created_at FROM messages WHERE embedding IS NULL ORDER BY created_at DESC LIMIT 50",
    ).all() as Array<{ thread_id: string; role: string; content: string; created_at: string }>;

    for (const r of recentMem) {
      const score = keywordOverlap(tokens, r.value);
      if (score > 0) {
        scored.push({ source: "memory", namespace: r.namespace, key: r.key, content: r.value, score: 0.26 + score * 0.1, created_at: r.created_at });
      }
    }
    for (const r of recentMsg) {
      const score = keywordOverlap(tokens, r.content);
      if (score > 0) {
        scored.push({ source: "message", thread_id: r.thread_id, role: r.role, content: r.content, score: 0.26 + score * 0.1, created_at: r.created_at });
      }
    }
  }

  // Dedup by a short content prefix. When several entries share the same prefix
  // (e.g. multiple revisions of the same fact: "My codename for X is..."),
  // keep the most recently updated one rather than the highest-scoring one —
  // semantically they're "the same fact" and the user wants the latest version.
  const groups = new Map<string, RecalledMemory>();
  for (const s of scored) {
    if (s.score <= 0.25) continue;
    const key = `${s.source}:${normalizeForDedup(s.content)}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, s);
    } else if (s.created_at > existing.created_at) {
      // Keep the newer one but propagate the highest score we've seen for the group
      // so it doesn't lose ranking against stale duplicates.
      groups.set(key, { ...s, score: Math.max(s.score, existing.score) });
    }
  }
  return Array.from(groups.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function normalizeForDedup(text: string): string {
  // First 80 chars after collapsing whitespace — long enough to distinguish
  // different topics but short enough that "My X for Y is FOO" and
  // "My X for Y is BAR" collapse into the same group.
  return text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 80);
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "of", "to", "in",
  "on", "at", "by", "for", "with", "about", "as", "what", "which", "who", "whose", "why",
  "how", "do", "does", "did", "i", "me", "my", "you", "your", "it", "its", "this", "that",
  "and", "or", "but", "if", "then", "than", "so", "have", "has", "had", "can", "will",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

function keywordOverlap(queryTokens: string[], text: string): number {
  const textLower = text.toLowerCase();
  let hits = 0;
  for (const t of queryTokens) {
    if (textLower.includes(t)) hits++;
  }
  return queryTokens.length === 0 ? 0 : hits / queryTokens.length;
}

function parseEmbedding(raw: string): number[] | null {
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) && arr.every((n) => typeof n === "number") ? (arr as number[]) : null;
  } catch {
    return null;
  }
}
