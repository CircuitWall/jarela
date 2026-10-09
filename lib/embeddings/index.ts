import { getProvider } from "@/lib/providers";
import { getModelConfig, getDefaultModelConfig, getModelParams, listModelConfigs, type ModelConfigRow } from "@/lib/stores/model-config";
import {
  getEmbeddingModelConfigName, getEmbeddingVectorsSignature, getMemoryPolicy, isLocalEmbeddingsEnabled,
  setEmbeddingVectorsSignature, type MemoryPolicy,
} from "@/lib/stores/app-settings";
import { getDb } from "@/lib/db";
import { SENSITIVE_MEMORY_NAMESPACES } from "@/lib/crypto/sensitive";
import { CHAT_ARCHIVE_NAMESPACE, parseChatArchiveKey } from "@/lib/stores/chat-archive-key";
import type { ProviderParams } from "@/lib/providers/types";
import { errorMessage } from "@/lib/utils/error";
import { createContentCache } from "@/lib/cache/keyed-cache";
import { createHash } from "node:crypto";
import {
  extractEmbeddableText, isStructuredMemoryEligible, memoryRecallText, memorySearchText, parseStructuredMemory,
} from "@/lib/memory/record";
import { LOCAL_EMBEDDING_CONFIG_NAME, LOCAL_EMBEDDING_MODEL_ID } from "./constants";
import { embedLocally, type LocalEmbeddingTask } from "./local";

// Sensitive namespaces (ADR-0005) are never surfaced via recall: their
// values are encrypted at rest, and credentials should not reach agent
// context via semantic search regardless.
const EXCLUDED_NS = [...SENSITIVE_MEMORY_NAMESPACES];
const EXCLUDED_NS_PLACEHOLDERS = EXCLUDED_NS.map(() => "?").join(",");

interface EmbeddingClient {
  modelId: string;
  /** Identifies the model that produced a vector; changes when the model does. */
  signature: string;
  cacheScope?: string;
  embed: (texts: string[]) => Promise<number[][]>;
}

// Embedding model resolution:
// 1. EMBEDDING_MODEL_CONFIG env var → name of a row in model_configs
// 2. Else: same provider as the default chat model + a sane default model_id
//    (text-embedding-3-small for OpenAI-compatible providers).
// Embedding generation is best-effort: any failure returns null and the caller
// falls back to substring search.
async function resolveConfiguredEmbeddingClient(): Promise<EmbeddingClient | null> {
  function fromConfig(cfg: ModelConfigRow | null): EmbeddingClient | null {
    if (!cfg) return null;
    const params: ProviderParams = getModelParams(cfg);
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
    return { modelId, signature: `${cfg.provider}:${modelId}`, embed: (texts) => provider.embed!(modelId, texts, params) };
  }

  const explicitName = process.env.EMBEDDING_MODEL_CONFIG;
  // 1) explicit embedding model name (if provided).
  if (explicitName) {
    const explicit = fromConfig(getModelConfig(explicitName));
    if (explicit) return explicit;
  }

  // 2) persisted app-level embedding model selection.
  const configuredName = getEmbeddingModelConfigName();
  if (configuredName) {
    const configured = fromConfig(getModelConfig(configuredName));
    if (configured) return configured;
  }

  // 3) default chat model if it also supports embeddings.
  const fromDefault = fromConfig(getDefaultModelConfig());
  if (fromDefault) return fromDefault;

  // 4) installation-safe fallback: any configured model with embed support.
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

async function resolveEmbeddingClient(task: LocalEmbeddingTask = "query"): Promise<EmbeddingClient | null> {
  if (isLocalEmbeddingsEnabled()) {
    return {
      modelId: LOCAL_EMBEDDING_MODEL_ID,
      signature: LOCAL_EMBEDDING_MODEL_ID,
      cacheScope: `${LOCAL_EMBEDDING_MODEL_ID}:${task}`,
      embed: (texts) => embedLocally(texts, task),
    };
  }
  return resolveConfiguredEmbeddingClient();
}

function isChatModelId(id: string): boolean {
  return /^(gpt-|claude-|deepseek-chat|deepseek-reasoner)/.test(id);
}

// An embedding is a pure function of (model, text), so a hit can never be
// stale. Worth caching because prepareThreadRun embeds on the critical path
// of every turn — auto-boundary detection alone re-embeds an almost unchanged
// baseline each time — and a warm round-trip is 200-800 ms.
const EMBEDDING_CACHE_ENTRIES = 512;
const embeddingCache = createContentCache<number[]>(EMBEDDING_CACHE_ENTRIES);

function embeddingCacheKey(modelId: string, text: string): string {
  return `${modelId}\u0000${createHash("sha1").update(text).digest("base64")}`;
}

/** @internal — test-only: drop memoised vectors between cases. */
export function _resetEmbeddingCache(): void {
  embeddingCache.clear();
}

async function embedWithClient(
  texts: string[],
  client: EmbeddingClient | null,
): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  if (!client) return null;

  const keys = texts.map((t) => embeddingCacheKey(client.cacheScope ?? client.modelId, t));
  const results = new Array<number[] | undefined>(texts.length);
  const missIndexes: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const hit = embeddingCache.get(keys[i]);
    if (hit) results[i] = hit;
    else missIndexes.push(i);
  }
  if (missIndexes.length === 0) return results as number[][];

  try {
    // Only misses go over the wire; duplicates inside one batch collapse too.
    const uniqueMissTexts: string[] = [];
    const uniqueMissKeyToIndex = new Map<string, number>();
    for (const i of missIndexes) {
      if (!uniqueMissKeyToIndex.has(keys[i])) {
        uniqueMissKeyToIndex.set(keys[i], uniqueMissTexts.length);
        uniqueMissTexts.push(texts[i]);
      }
    }

    const fetched = await client.embed(uniqueMissTexts);
    if (!fetched) return null;

    for (const i of missIndexes) {
      const vector = fetched[uniqueMissKeyToIndex.get(keys[i]) as number];
      if (!vector) return null;
      results[i] = vector;
      embeddingCache.set(keys[i], vector);
    }
    return results as number[][];
  } catch (err) {
    console.warn("[embeddings] failed:", errorMessage(err));
    return null;
  }
}

// Stored content (memory entries, chat messages): "passage" side of the
// bundled model when enabled, otherwise the configured provider.
export async function embed(texts: string[]): Promise<number[][] | null> {
  return embedWithClient(texts, await resolveEmbeddingClient("passage"));
}

export async function embedQuery(texts: string[]): Promise<number[][] | null> {
  return embedWithClient(texts, await resolveEmbeddingClient("query"));
}

export async function embedQueryOne(text: string): Promise<number[] | null> {
  const out = await embedQuery([text]);
  return out?.[0] ?? null;
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
  return TRANSIENT_RE.test(errorMessage(err));
}

async function callEmbedWithRetry(
  client: EmbeddingClient,
  texts: string[],
): Promise<number[][]> {
  // 250ms → 1s → 4s. Three attempts is enough to ride through a brief
  // rate-limit blip without dragging out a whole reindex run.
  const backoffs = [250, 1000, 4000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await client.embed(texts);
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
  /**
   * Parallel to `vectors`. True at index i means the failure at that index is
   * non-retryable (a 4xx other than 429 on that specific input) — the caller
   * should stop retrying it rather than resubmitting on every future pass.
   * False for successes and for failures worth retrying later (transient
   * errors, short-response padding, or no provider configured).
   */
  terminal: boolean[];
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
  if (texts.length === 0) return { vectors: [], error: null, failed: 0, terminal: [] };
  const client = await resolveEmbeddingClient("passage");
  if (!client) {
    // Missing config, not bad content — fixing the config should let these
    // retry, so this is never a terminal per-item failure.
    return {
      vectors: texts.map(() => null),
      error: "no embedding provider configured",
      failed: texts.length,
      terminal: texts.map(() => false),
    };
  }
  return embedBestEffortInternal(client, texts);
}

async function embedBestEffortInternal(
  client: EmbeddingClient,
  texts: string[],
): Promise<EmbedBestEffortResult> {
  try {
    const vectors = await callEmbedWithRetry(client, texts);
    if (vectors.length === texts.length) {
      return { vectors, error: null, failed: 0, terminal: texts.map(() => false) };
    }
    // Provider returned a short array — pad with nulls so indices line up.
    // Which input the provider dropped is not knowable here, so treat this
    // as retryable rather than guessing which slot to mark terminal.
    const padded: (number[] | null)[] = texts.map((_, i) => vectors[i] ?? null);
    const failed = padded.filter((v) => v === null).length;
    return {
      vectors: padded,
      error: `embedding provider returned ${vectors.length}/${texts.length} vectors`,
      failed,
      terminal: padded.map(() => false),
    };
  } catch (err) {
    const msg = errorMessage(err);
    if (texts.length === 1) {
      console.warn("[embeddings] failed:", msg);
      return { vectors: [null], error: msg, failed: 1, terminal: [!isTransient(err)] };
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
      terminal: [...left.terminal, ...right.terminal],
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

// Jarela is a single long-running process (no multi-instance cache-invalidation
// concern), and recall() runs on every agent turn — re-fetching every embedded
// row and JSON.parse-ing its vector on every call is wasted, repeated work on
// data that rarely changes between turns. These caches hold the *parsed*
// vectors in memory for the process lifetime; lib/stores/memory.ts and
// lib/stores/threads.ts keep them current via the upsert/evict calls below
// right after they persist a new embedding, so recall() never re-scans SQLite
// after the first lazy load.
interface CachedMemoryEmbedding {
  namespace: string; key: string; value: string; embedding: number[]; created_at: string;
}
interface CachedMessageEmbedding {
  msg_id: string; thread_id: string; role: string; content: string; embedding: number[]; created_at: string;
}

let memEmbedCache: Map<string, CachedMemoryEmbedding> | null = null;
let msgEmbedCache: Map<string, CachedMessageEmbedding> | null = null;

function memCacheKey(namespace: string, key: string): string {
  return `${namespace}\u0000${key}`;
}

function loadMemEmbedCache(): Map<string, CachedMemoryEmbedding> {
  if (memEmbedCache) return memEmbedCache;
  const rows = getDb().prepare(
    `SELECT namespace, key, value, embedding, created_at FROM memory_store
      WHERE embedding IS NOT NULL AND namespace NOT IN (${EXCLUDED_NS_PLACEHOLDERS})`,
  ).all(...EXCLUDED_NS) as Array<{ namespace: string; key: string; value: string; embedding: string; created_at: string }>;
  const cache = new Map<string, CachedMemoryEmbedding>();
  for (const r of rows) {
    const vec = parseEmbedding(r.embedding);
    if (!vec) continue;
    cache.set(memCacheKey(r.namespace, r.key), { namespace: r.namespace, key: r.key, value: r.value, embedding: vec, created_at: r.created_at });
  }
  memEmbedCache = cache;
  return cache;
}

function loadMsgEmbedCache(): Map<string, CachedMessageEmbedding> {
  if (msgEmbedCache) return msgEmbedCache;
  const rows = getDb().prepare(
    "SELECT msg_id, thread_id, role, content, embedding, created_at FROM messages WHERE embedding IS NOT NULL",
  ).all() as Array<{ msg_id: string; thread_id: string; role: string; content: string; embedding: string; created_at: string }>;
  const cache = new Map<string, CachedMessageEmbedding>();
  for (const r of rows) {
    const vec = parseEmbedding(r.embedding);
    if (!vec) continue;
    cache.set(r.msg_id, { msg_id: r.msg_id, thread_id: r.thread_id, role: r.role, content: r.content, embedding: vec, created_at: r.created_at });
  }
  msgEmbedCache = cache;
  return cache;
}

// Write-through — called right after a caller persists a fresh embedding, so
// the cache reflects it immediately instead of waiting for a full reload.
// No-op before the cache is first populated; loadMemEmbedCache() will pick
// the row up from SQLite on that first load.
export function upsertMemoryEmbedCache(namespace: string, key: string, value: string, embedding: number[], created_at: string): void {
  if (!memEmbedCache || EXCLUDED_NS.includes(namespace)) return;
  memEmbedCache.set(memCacheKey(namespace, key), { namespace, key, value, embedding, created_at });
}

export function evictMemoryEmbedCache(namespace: string, key: string): void {
  memEmbedCache?.delete(memCacheKey(namespace, key));
}

export function upsertMessageEmbedCache(msg_id: string, thread_id: string, role: string, content: string, embedding: number[], created_at: string): void {
  if (!msgEmbedCache) return;
  msgEmbedCache.set(msg_id, { msg_id, thread_id, role, content, embedding, created_at });
}

// Bulk removals (thread delete, /compact pruning) don't track which msg_ids
// they removed at the call site — dropping the whole cache is cheap and
// correct; the next recall() lazily rebuilds it from the now-smaller table.
export function resetMessageEmbedCache(): void {
  msgEmbedCache = null;
}

// Same pattern for bulk memory_store writes — pruneThreadMessages inserts
// a batch of chat_archive rows at /compact time, so dropping the memory
// cache lets the next recall() pick them up from SQLite in one scan
// rather than threading a parsed-vector upsert through two modules.
export function resetMemoryEmbedCache(): void {
  memEmbedCache = null;
}

/** @internal — test-only: force both caches to rebuild from SQLite. */
export function _resetEmbedCaches(): void {
  memEmbedCache = null;
  msgEmbedCache = null;
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
  match?: "semantic" | "keyword" | "literal";
}

export interface MemorySearchOptions {
  limit?: number;
  policy?: MemoryPolicy;
  /** Which stores to search. Chat includes archived turns. Default "all". */
  sources?: "all" | "memory" | "messages";
  /** Restrict to one memory namespace; chat hits are excluded. */
  namespace?: string;
  /** Also match the query as literal text and rank those hits first. */
  literal?: boolean;
  /** Minimum cosine score for semantic hits; keyword and literal fallbacks retain their own floor. */
  minSimilarity?: number;
  /** Optional separate cosine floor for chat messages. */
  minMessageSimilarity?: number;
}

const LITERAL_SCORE = 0.9;
const LITERAL_ROW_LIMIT = 50;
export const DEFAULT_LOCAL_CHAT_MIN_SIMILARITY = 0.84;

export function getDefaultChatMinSimilarity(): number {
  return isLocalEmbeddingsEnabled() ? DEFAULT_LOCAL_CHAT_MIN_SIMILARITY : 0.25;
}

type MemoryRowLike = { namespace: string; key: string; value: string; created_at: string };

// Archived chat turns live in memory_store but are surfaced as chat hits so
// buildRecallContext renders them exactly like a live message (role, thread
// tag, date). A malformed archive key falls through to a plain memory hit.
function toRecalled(r: MemoryRowLike, score: number, policy: MemoryPolicy, wantMem: boolean, wantMsg: boolean): RecalledMemory | null {
  if (r.namespace === CHAT_ARCHIVE_NAMESPACE) {
    const parsed = parseChatArchiveKey(r.key);
    if (parsed) {
      return wantMsg
        ? { source: "message", thread_id: parsed.thread_id, role: parsed.role, content: r.value, score, created_at: r.created_at }
        : null;
    }
  }
  if (!wantMem) return null;
  const structured = parseStructuredMemory(r.value);
  if (structured && !isStructuredMemoryEligible(structured, policy)) return null;
  if (!structured && policy === "important") return null;
  const content = memoryRecallText(r.namespace, r.key, r.value);
  if (content === null) return null;
  return { source: "memory", namespace: r.namespace, key: r.key, content, score, created_at: r.created_at };
}

// The one search behind proactive recall, memory_search, memory_list with a
// search term, and the Memory panel. Compares the query embedding against
// every embedded memory entry and chat message, adds keyword overlap for rows
// still pending embedding, and (when `literal`) exact text matches.
export async function searchMemory(query: string, opts: MemorySearchOptions = {}): Promise<RecalledMemory[]> {
  const { limit = 5, policy = getMemoryPolicy(), sources = "all", namespace, literal = false } = opts;
  const minSimilarity = Math.max(0, Math.min(1, opts.minSimilarity ?? 0.25));
  const minMessageSimilarity = Math.max(0, Math.min(1, opts.minMessageSimilarity ?? minSimilarity));
  const wantMem = sources !== "messages";
  const wantMsg = sources !== "memory" && !namespace;
  const qVec = await embedQueryOne(query);
  const db = getDb();
  const scored: RecalledMemory[] = [];
  if (qVec) void reembedStaleVectors(qVec.length);

  // Reads pre-parsed vectors from the in-memory cache instead of re-querying
  // and re-parsing every embedded row on each call.
  if (qVec) {
    for (const r of loadMemEmbedCache().values()) {
      if (namespace && r.namespace !== namespace) continue;
      const score = cosine(qVec, r.embedding);
      const hit = score > minSimilarity ? toRecalled(r, score, policy, wantMem, wantMsg) : null;
      if (hit) scored.push({ ...hit, match: "semantic" });
    }
    if (wantMsg) {
      for (const r of loadMsgEmbedCache().values()) {
        const score = cosine(qVec, r.embedding);
        if (score <= minMessageSimilarity) continue;
        scored.push({
          source: "message", thread_id: r.thread_id, role: r.role,
          content: r.content, score, created_at: r.created_at,
          match: "semantic",
        });
      }
    }
  }

  // Keyword overlap on rows still pending embedding (write-then-query case).
  // Capped below the embedding floor so a real semantic match always wins.
  const tokens = tokenize(query);
  if (tokens.length > 0) {
    const nsClause = namespace ? " AND namespace=?" : "";
    const recentMem = db.prepare(
      `SELECT namespace, key, value, created_at FROM memory_store
        WHERE embedding IS NULL AND namespace NOT IN (${EXCLUDED_NS_PLACEHOLDERS})${nsClause}
        ORDER BY updated_at DESC LIMIT 50`,
    ).all(...EXCLUDED_NS, ...(namespace ? [namespace] : [])) as MemoryRowLike[];
    for (const r of recentMem) {
      const probe = toRecalled(r, 0, policy, wantMem, wantMsg);
      if (!probe) continue;
      const overlap = keywordOverlap(tokens, probe.content);
      if (overlap > 0) scored.push({ ...probe, score: 0.26 + overlap * 0.1, match: "keyword" });
    }
    if (wantMsg) {
      const recentMsg = db.prepare(
        "SELECT thread_id, role, content, created_at FROM messages WHERE embedding IS NULL ORDER BY created_at DESC LIMIT 50",
      ).all() as Array<{ thread_id: string; role: string; content: string; created_at: string }>;
      for (const r of recentMsg) {
        const overlap = keywordOverlap(tokens, r.content);
        if (overlap > 0) {
          scored.push({ source: "message", thread_id: r.thread_id, role: r.role, content: r.content, score: 0.26 + overlap * 0.1, created_at: r.created_at, match: "keyword" });
        }
      }
    }
  }

  // Exact text matches (keys, ids, error codes) that similarity can miss.
  const needle = query.trim();
  if (literal && needle.length >= 2) {
    const like = `%${needle.replace(/[\\%_]/g, "\\$&")}%`;
    if (wantMem || wantMsg) {
      const rows = db.prepare(
        `SELECT namespace, key, value, created_at FROM memory_store
          WHERE (key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\')
            AND namespace NOT IN (${EXCLUDED_NS_PLACEHOLDERS})${namespace ? " AND namespace=?" : ""}
          ORDER BY updated_at DESC LIMIT ?`,
      ).all(like, like, ...EXCLUDED_NS, ...(namespace ? [namespace] : []), LITERAL_ROW_LIMIT) as MemoryRowLike[];
      for (const r of rows) {
        const hit = toRecalled(r, LITERAL_SCORE, policy, wantMem, wantMsg);
        if (hit) scored.push({ ...hit, match: "literal" });
      }
    }
    if (wantMsg) {
      const rows = db.prepare(
        "SELECT thread_id, role, content, created_at FROM messages WHERE content LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?",
      ).all(like, LITERAL_ROW_LIMIT) as Array<{ thread_id: string; role: string; content: string; created_at: string }>;
      for (const r of rows) {
        scored.push({ source: "message", thread_id: r.thread_id, role: r.role, content: r.content, score: LITERAL_SCORE, created_at: r.created_at, match: "literal" });
      }
    }
  }

  // Dedup by a short content prefix. When several entries share the same prefix
  // (e.g. multiple revisions of the same fact: "My codename for X is..."),
  // keep the most recently updated one rather than the highest-scoring one —
  // semantically they're "the same fact" and the user wants the latest version.
  const groups = new Map<string, RecalledMemory>();
  for (const s of scored) {
    const floor = s.source === "message" ? minMessageSimilarity : minSimilarity;
    if (s.match === "semantic" ? s.score <= floor : s.score <= 0.25) continue;
    const key = `${s.source}:${normalizeForDedup(s.content)}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, s);
    } else if (s.created_at > existing.created_at) {
      // Keep the newer one but propagate the highest score we've seen for the group
      // so it doesn't lose ranking against stale duplicates.
      groups.set(key, { ...s, score: Math.max(s.score, existing.score) });
    } else if (s.score > existing.score) {
      // Same row found by more than one pass (semantic and literal).
      groups.set(key, { ...existing, score: s.score });
    }
  }
  return Array.from(groups.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Proactive recall: every store, memory-policy filtered, no literal pass. */
export function recall(query: string, limit = 5, policy: MemoryPolicy = getMemoryPolicy()): Promise<RecalledMemory[]> {
  return searchMemory(query, { limit, policy });
}

// Stored vectors from a previous embedding model silently vanish from recall:
// a different dimension scores 0 in cosine(), and a different model with the
// same dimension scores meaninglessly. Two signals mark them stale — a model
// signature persisted with the settings, and a dimension mismatch against the
// live query vector — and a background pass re-embeds them. The same pass
// embeds rows that never got a vector (written while no model worked).
const REEMBED_BATCH = 32;
const REEMBED_COOLDOWN_MS = 60_000;
const NULL_SCAN_INTERVAL_MS = 10 * 60_000;
const NULL_BACKFILL_LIMIT = 500;
// Raw-SQL settings rows are intentionally stored without a vector.
const NULL_BACKFILL_SKIP_NS = [...EXCLUDED_NS, "app-settings"];

export interface ReembedStatus {
  running: boolean;
  total: number;
  done: number;
  error: string | null;
}

const reembedStatus: ReembedStatus = { running: false, total: 0, done: 0, error: null };
let reembedBlockedUntil = 0;
let nullScanAt = 0;
// Rows already rewritten under `reembedDoneSignature`, so a retry after a
// failure resumes instead of starting over.
const reembedDone = new Set<string>();
let reembedDoneSignature: string | null = null;

export function getReembedStatus(): ReembedStatus {
  return { ...reembedStatus };
}

/** @internal — test-only. */
export function _resetReembedState(): void {
  reembedStatus.running = false;
  reembedStatus.total = 0;
  reembedStatus.done = 0;
  reembedStatus.error = null;
  reembedBlockedUntil = 0;
  nullScanAt = 0;
  reembedDone.clear();
  reembedDoneSignature = null;
}

function memoryEmbedText(r: { namespace: string; key: string; value: string }): string {
  // Archived chat turns were embedded from the message text, not as a memory entry.
  if (r.namespace === CHAT_ARCHIVE_NAMESPACE) return extractEmbeddableText(r.value);
  let parsed: unknown = r.value;
  try { parsed = JSON.parse(r.value); } catch { /* legacy plain text */ }
  return `${r.namespace}/${r.key}: ${memorySearchText(r.namespace, r.key, parsed)}`;
}

type MessageRowLike = { msg_id: string; thread_id: string; role: string; content: string; created_at: string };

/**
 * Re-embeds memory and message vectors that don't belong to the active model
 * and backfills rows that never had one. Pass `dim` (the live query vector
 * length) to also catch dimension mismatches. Safe to call often: it no-ops
 * when nothing is pending, while one is running, and for a minute after a
 * failure; the never-embedded scan runs at most every ten minutes.
 */
export async function reembedStaleVectors(dim?: number): Promise<void> {
  if (reembedStatus.running || Date.now() < reembedBlockedUntil) return;
  reembedStatus.running = true;
  try {
    const signature = (await resolveEmbeddingClient("passage"))?.signature ?? null;
    if (!signature) return;
    const stored = getEmbeddingVectorsSignature();
    // First run after upgrade: adopt the current model rather than rewriting everything.
    if (stored === null) setEmbeddingVectorsSignature(signature);
    const changed = stored !== null && stored !== signature;
    if (reembedDoneSignature !== signature) {
      reembedDone.clear();
      reembedDoneSignature = signature;
    }
    const stale = (key: string, vec: number[]) =>
      !reembedDone.has(key) && (changed || (dim !== undefined && vec.length !== dim));
    const memTargets: MemoryRowLike[] = [...loadMemEmbedCache().values()]
      .filter((r) => stale(`m\0${r.namespace}\0${r.key}`, r.embedding));
    const msgTargets: MessageRowLike[] = [...loadMsgEmbedCache().values()]
      .filter((r) => stale(`g\0${r.msg_id}`, r.embedding));

    const db = getDb();
    if (Date.now() - nullScanAt >= NULL_SCAN_INTERVAL_MS) {
      nullScanAt = Date.now();
      const skip = NULL_BACKFILL_SKIP_NS.map(() => "?").join(",");
      const nullMem = db.prepare(
        `SELECT namespace, key, value, created_at FROM memory_store
          WHERE embedding IS NULL AND namespace NOT IN (${skip}) ORDER BY updated_at DESC LIMIT ?`,
      ).all(...NULL_BACKFILL_SKIP_NS, NULL_BACKFILL_LIMIT) as MemoryRowLike[];
      const nullMsg = db.prepare(
        `SELECT msg_id, thread_id, role, content, created_at FROM messages
          WHERE embedding IS NULL AND length(content) >= 12
            AND (metadata IS NULL OR metadata NOT LIKE '%automation_activity%')
          ORDER BY created_at DESC LIMIT ?`,
      ).all(NULL_BACKFILL_LIMIT) as MessageRowLike[];
      memTargets.push(...nullMem.filter((r) => !reembedDone.has(`m\0${r.namespace}\0${r.key}`)));
      msgTargets.push(...nullMsg.filter((r) => extractEmbeddableText(r.content).trim().length >= 12 && !reembedDone.has(`g\0${r.msg_id}`)));
      // A full page means more may be waiting; scan again on the next call.
      if (nullMem.length === NULL_BACKFILL_LIMIT || nullMsg.length === NULL_BACKFILL_LIMIT) nullScanAt = 0;
    }

    reembedStatus.total = memTargets.length + msgTargets.length;
    reembedStatus.done = 0;
    reembedStatus.error = null;

    for (let i = 0; i < memTargets.length; i += REEMBED_BATCH) {
      const batch = memTargets.slice(i, i + REEMBED_BATCH);
      const vecs = await embed(batch.map(memoryEmbedText));
      if (!vecs) throw new Error("embedding provider unavailable");
      batch.forEach((r, j) => {
        const rows = db.prepare("UPDATE memory_store SET embedding=? WHERE namespace=? AND key=? AND value=?")
          .run(JSON.stringify(vecs[j]), r.namespace, r.key, r.value).changes;
        if (rows > 0) upsertMemoryEmbedCache(r.namespace, r.key, r.value, vecs[j], r.created_at);
        reembedDone.add(`m\0${r.namespace}\0${r.key}`);
      });
      reembedStatus.done += batch.length;
    }
    for (let i = 0; i < msgTargets.length; i += REEMBED_BATCH) {
      const batch = msgTargets.slice(i, i + REEMBED_BATCH);
      const vecs = await embed(batch.map((r) => extractEmbeddableText(r.content)));
      if (!vecs) throw new Error("embedding provider unavailable");
      batch.forEach((r, j) => {
        db.prepare("UPDATE messages SET embedding=? WHERE msg_id=?").run(JSON.stringify(vecs[j]), r.msg_id);
        upsertMessageEmbedCache(r.msg_id, r.thread_id, r.role, r.content, vecs[j], r.created_at);
        reembedDone.add(`g\0${r.msg_id}`);
      });
      reembedStatus.done += batch.length;
    }
    if (changed) setEmbeddingVectorsSignature(signature);
  } catch (err) {
    reembedStatus.error = errorMessage(err);
    reembedBlockedUntil = Date.now() + REEMBED_COOLDOWN_MS;
    console.warn("[embeddings] re-embed failed:", reembedStatus.error);
  } finally {
    reembedStatus.running = false;
  }
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
