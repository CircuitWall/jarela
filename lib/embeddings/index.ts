import { getProvider } from "@/lib/providers";
import { getModelConfig, getDefaultModelConfig } from "@/lib/stores/model-config";
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
  const explicitName = process.env.EMBEDDING_MODEL_CONFIG;
  const cfg = explicitName ? getModelConfig(explicitName) : getDefaultModelConfig();
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
