import { getDb } from "@/lib/db";
import { embedOne, searchMemory, upsertMemoryEmbedCache, evictMemoryEmbedCache } from "@/lib/embeddings";
import { encrypt, decryptIfNeeded } from "@/lib/crypto/envelope";
import { isSensitiveMemoryNamespace } from "@/lib/crypto/sensitive";
import { isLegacyStructuredMemoryRaw, memorySearchText, parseStructuredMemory, type StructuredMemoryRecord } from "@/lib/memory/record";
import { isSkillExecutionPolicySetting } from "@/lib/skills/execution-policy";
import { isAdvertisementMemory } from "@/lib/agents/advertisement-contract";

// Older writes' history entries won't grow past this before the oldest
// snapshot is dropped, so a long-lived key can't bloat the row forever.
const MAX_MEMORY_HISTORY_ENTRIES = 20;

const now = () => new Date().toISOString();

// Explicit column list for memory reads — omits `embedding` (~20KB of
// JSON-encoded float[] per row), which only the embeddings module reads.
// Avoids dragging it through the listMemory / getMemory result set.
const MEM_COLS_SQL = "SELECT namespace, key, value, created_at, updated_at FROM memory_store";

// Decrypt rows in sensitive namespaces before handing them back to
// callers. Non-sensitive namespaces pass through untouched (their values
// are not encrypted at rest, by design — see ADR-0005).
function decryptRow(row: MemoryRow): MemoryRow {
  if (!isSensitiveMemoryNamespace(row.namespace)) return row;
  return { ...row, value: decryptIfNeeded(row.value) };
}

// Fire-and-forget: compute and persist an embedding without blocking the write.
// Failures (no embed provider, network down) are logged in embeddings/index.ts
// and the row simply stays without an embedding — recall falls back to substring.
function asyncEmbed(text: string, persist: (vec: number[]) => void): void {
  embedOne(text).then((vec) => { if (vec) persist(vec); }).catch(() => { /* already logged */ });
}

export interface MemoryRow {
  namespace: string; key: string; value: string;
  created_at: string; updated_at: string;
}

// Internal maintenance view of a row. `scanMemoryRows` returns the raw stored
// value (ciphertext for sensitive namespaces, which maintenance callers
// exclude) so callers can fingerprint and classify a row without loading
// `embedding`. It is not a substitute for `getMemory`'s decryption.
export interface MemoryScanRow extends MemoryRow {
  embedded: boolean;
}

export interface MemoryScanOptions {
  /** Restrict the scan to one namespace. */
  namespace?: string;
  /** Namespaces to skip in SQL so excluded rows are never transferred. */
  excludeNamespaces?: readonly string[];
  /** Keyset position of the last row already consumed, from the prior batch. */
  after?: { namespace: string; key: string } | null;
  batchSize?: number;
}

/** Upper bound for one scan batch; keeps a single batch bounded regardless of store size. */
export const MEMORY_SCAN_MAX_BATCH = 2_000;

/**
 * Read one ordered batch of rows using the (namespace, key) primary key as a
 * keyset cursor. Maintenance callers page until a short batch arrives instead
 * of loading the whole store, so scan memory stays proportional to the batch
 * and to whatever the caller accumulates per row — never to store size.
 */
export function scanMemoryRows(options: MemoryScanOptions = {}): MemoryScanRow[] {
  const batchSize = Math.min(Math.max(Math.trunc(options.batchSize ?? 500), 1), MEMORY_SCAN_MAX_BATCH);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.namespace) {
    where.push("namespace=?");
    params.push(options.namespace);
  }
  const excluded = [...new Set(options.excludeNamespaces ?? [])];
  if (excluded.length > 0) {
    where.push(`namespace NOT IN (${excluded.map(() => "?").join(",")})`);
    params.push(...excluded);
  }
  if (options.after) {
    where.push("(namespace>? OR (namespace=? AND key>?))");
    params.push(options.after.namespace, options.after.namespace, options.after.key);
  }
  const sql = `SELECT namespace,key,value,created_at,updated_at,(embedding IS NOT NULL) AS embedded
    FROM memory_store${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
    ORDER BY namespace,key LIMIT ?`;
  const rows = getDb().prepare(sql).all(...params, batchSize) as unknown as Array<MemoryRow & { embedded: number }>;
  return rows.map(({ embedded, ...row }) => ({ ...row, embedded: Boolean(embedded) }));
}

/** Row counts per namespace, for bounded store-wide summaries. */
export function memoryNamespaceCounts(): Array<{ namespace: string; rows: number }> {
  return getDb()
    .prepare("SELECT namespace, COUNT(*) AS rows FROM memory_store GROUP BY namespace ORDER BY namespace")
    .all() as unknown as Array<{ namespace: string; rows: number }>;
}

/** Raw stored value plus revision marker, used for compare-and-set maintenance writes. */
export function getStoredMemoryValue(namespace: string, key: string): { value: string; updated_at: string } | null {
  const row = getDb()
    .prepare("SELECT value, updated_at FROM memory_store WHERE namespace=? AND key=?")
    .get(namespace, key) as { value: string; updated_at: string } | undefined;
  return row ?? null;
}

export function listMemory(namespace?: string, search?: string, limit = 50): MemoryRow[] {
  if (namespace === "agent-advertisements") throw new Error("Use agent advertisement settings to inspect derived metadata");
  let sql = MEM_COLS_SQL + " WHERE namespace<>? AND NOT(namespace=? AND (key=? OR key LIKE ?))";
  const params: (string | number)[] = ["agent-advertisements", "app-settings", "agent-advertisement-policy", "agent-advertisement-usage%"];
  if (namespace) { sql += " AND namespace=?"; params.push(namespace); }
  if (search) { sql += " AND (key LIKE ? OR value LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }
  sql += " ORDER BY updated_at DESC LIMIT ?";
  params.push(limit);
  const rows = getDb().prepare(sql).all(...params) as unknown as MemoryRow[];
  // P2.7: when the caller pinned the namespace and it isn't in the
  // sensitive set, every row's value is plaintext anyway — skip the
  // per-row decryptRow allocation. The unfiltered case still has to
  // check each row since namespaces vary.
  const decrypted = namespace && !isSensitiveMemoryNamespace(namespace) ? rows : rows.map(decryptRow);
  return decrypted.map(migrateRowIfNeeded);
}

// Hybrid search for the memory tools and the Memory panel: similarity and
// exact-text hits first, then plain LIKE rows so entries that similarity
// deliberately hides (sensitive, archived, expired) can still be found by name.
export async function searchMemoryRows(namespace: string | undefined, search: string, limit = 20): Promise<MemoryRow[]> {
  const out = new Map<string, MemoryRow>();
  const add = (r: MemoryRow | null) => {
    if (r && out.size < limit) out.set(`${r.namespace}\0${r.key}`, r);
  };
  try {
    const hits = await searchMemory(search, { limit: limit * 2, sources: "memory", namespace, literal: true, policy: "detailed" });
    for (const h of hits) if (h.namespace && h.key) add(getMemory(h.namespace, h.key));
  } catch {
    // No usable embedding model: the LIKE rows below still answer.
  }
  for (const r of listMemory(namespace, search, limit)) add(r);
  return [...out.values()];
}

export function getMemory(namespace: string, key: string): MemoryRow | null {
  if (isAdvertisementMemory(namespace, key)) throw new Error("Use agent advertisement settings to inspect derived metadata");
  const row = (getDb().prepare(MEM_COLS_SQL + " WHERE namespace=? AND key=?").get(namespace, key) as unknown as MemoryRow) ?? null;
  return row ? migrateRowIfNeeded(decryptRow(row)) : null;
}

// Lazy schema migration: a legacy v1 row is upgraded to the current
// structured schema the first time it's read, and the upgrade is written
// straight back so later reads (and search text) hit the current shape.
// Rows that aren't structured memory at all, or are already current, pass
// through untouched — no startup batch job, no DB migration.
function migrateRowIfNeeded(row: MemoryRow): MemoryRow {
  let raw: unknown;
  try { raw = JSON.parse(row.value); } catch { return row; }
  if (!isLegacyStructuredMemoryRaw(raw)) return row;
  const upgraded = parseStructuredMemory(row.value);
  if (!upgraded) return row;
  const json = JSON.stringify(upgraded);
  const stored = isSensitiveMemoryNamespace(row.namespace) ? encrypt(json) : json;
  getDb().prepare("UPDATE memory_store SET value=? WHERE namespace=? AND key=?").run(stored, row.namespace, row.key);
  return { ...row, value: json };
}

function normalizeStructuredMemoryValue(value: unknown, previous: StructuredMemoryRecord | null, updatedAt: string): unknown {
  const next = parseStructuredMemory(value);
  if (!next) return value;
  if (!previous) return { ...next, history: [] };
  // Snapshot only the previous record's own fields — never its `history`
  // — so revisions can't nest inside one another and the row stays flat.
  const { history: previousHistory, ...previousSnapshot } = previous;
  const history = [...previousHistory, { updated_at: updatedAt, record: previousSnapshot }].slice(-MAX_MEMORY_HISTORY_ENTRIES);
  return { ...next, history };
}

export function putMemory(namespace: string, key: string, value: unknown): MemoryRow {
  if (isAdvertisementMemory(namespace, key)) throw new Error("Use agent advertisement settings to change generation policy or metadata");
  if (isSkillExecutionPolicySetting(namespace, key)) throw new Error("Skill execution policy must be changed in Security settings");
  const t = now();
  // Read only insertion time and the prior value needed for revision history.
  const existing = getDb()
    .prepare("SELECT created_at, value FROM memory_store WHERE namespace=? AND key=?")
    .get(namespace, key) as { created_at?: string; value?: string } | undefined;
  const created_at = existing?.created_at ?? t;

  const previousValue = existing?.value && isSensitiveMemoryNamespace(namespace)
    ? decryptIfNeeded(existing.value) : existing?.value;
  const previous = previousValue ? parseStructuredMemory(previousValue) : null;
  const normalizedValue = normalizeStructuredMemoryValue(value, previous, t);
  const json = JSON.stringify(normalizedValue);
  // Encrypt the value column at rest for sensitive namespaces (ADR-0005).
  // Embeddings (below) keep using the plaintext text so semantic recall
  // still works for non-sensitive namespaces; sensitive namespaces are
  // not the kind of content we expect semantic recall against anyway.
  const stored = isSensitiveMemoryNamespace(namespace) ? encrypt(json) : json;
  getDb()
    .prepare("INSERT OR REPLACE INTO memory_store (namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,NULL)")
    .run(namespace, key, stored, created_at, t);
  // Structured records embed their subject, tags, and content rather than
  // JSON syntax, improving semantic recall while legacy values stay intact.
  const text = memorySearchText(namespace, key, normalizedValue);
  asyncEmbed(`${namespace}/${key}: ${text}`, (vec) => {
    getDb()
      .prepare("UPDATE memory_store SET embedding=? WHERE namespace=? AND key=?")
      .run(JSON.stringify(vec), namespace, key);
    upsertMemoryEmbedCache(namespace, key, json, vec, t);
  });
  return { namespace, key, value: json, created_at, updated_at: t };
}

export function deleteMemory(namespace: string, key: string): boolean {
  if (isAdvertisementMemory(namespace, key)) throw new Error("Use agent advertisement settings to change generation policy or metadata");
  if (isSkillExecutionPolicySetting(namespace, key)) throw new Error("Skill execution policy must be changed in Security settings");
  const removed = (getDb().prepare("DELETE FROM memory_store WHERE namespace=? AND key=?").run(namespace, key) as { changes: number }).changes > 0;
  evictMemoryEmbedCache(namespace, key);
  return removed;
}
