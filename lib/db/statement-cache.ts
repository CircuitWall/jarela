import type { DatabaseSync, StatementSync } from "node:sqlite";

const MAX_CACHED_STATEMENTS = 128;
const caches = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

// Only immediate get/all reads use this cache. Do not expose iterators or
// change statement options: both carry mutable state across callers.
export function cachedRead(db: DatabaseSync, sql: string): Pick<StatementSync, "get" | "all"> {
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }
  const existing = cache.get(sql);
  if (existing) {
    cache.delete(sql);
    cache.set(sql, existing);
    return existing;
  }
  const statement = db.prepare(sql);
  cache.set(sql, statement);
  if (cache.size > MAX_CACHED_STATEMENTS) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return statement;
}

export function clearStatementCache(db: DatabaseSync): void {
  caches.delete(db);
}
