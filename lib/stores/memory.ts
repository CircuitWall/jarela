import { getDb } from "@/lib/db";
import { embedOne } from "@/lib/embeddings";

const now = () => new Date().toISOString();

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

export function listMemory(namespace?: string, search?: string, limit = 50): MemoryRow[] {
  let sql = "SELECT * FROM memory_store WHERE 1=1";
  const params: (string | number)[] = [];
  if (namespace) { sql += " AND namespace=?"; params.push(namespace); }
  if (search) { sql += " AND (key LIKE ? OR value LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }
  sql += " ORDER BY updated_at DESC LIMIT ?";
  params.push(limit);
  return getDb().prepare(sql).all(...params) as unknown as MemoryRow[];
}

export function getMemory(namespace: string, key: string): MemoryRow | null {
  return (getDb().prepare("SELECT * FROM memory_store WHERE namespace=? AND key=?").get(namespace, key) as unknown as MemoryRow) ?? null;
}

export function putMemory(namespace: string, key: string, value: unknown): MemoryRow {
  const t = now();
  const existing = getMemory(namespace, key);
  const created_at = existing?.created_at ?? t;
  const json = JSON.stringify(value);
  getDb()
    .prepare("INSERT OR REPLACE INTO memory_store (namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,NULL)")
    .run(namespace, key, json, created_at, t);
  // Embed the value text (not the JSON wrapping) so recall matches the semantic content.
  const text = typeof value === "string" ? value : json;
  asyncEmbed(`${namespace}/${key}: ${text}`, (vec) => {
    getDb()
      .prepare("UPDATE memory_store SET embedding=? WHERE namespace=? AND key=?")
      .run(JSON.stringify(vec), namespace, key);
  });
  return { namespace, key, value: json, created_at, updated_at: t };
}

export function deleteMemory(namespace: string, key: string): boolean {
  return (getDb().prepare("DELETE FROM memory_store WHERE namespace=? AND key=?").run(namespace, key) as { changes: number }).changes > 0;
}
