// Generic change-tracker (ADR-0025). One row per (scope, key) holds a
// fingerprint string the producer chose — typically a content hash, an
// "mtime:size" stat tuple, or an etag. recordSeen() compares against the
// stored value and atomically updates it, returning whether anything
// changed.
//
// Concurrency model: SQLite serialises writes; recordSeen() is one
// statement that returns the previous fingerprint (or null). Two
// producers calling recordSeen() with the same fingerprint will both
// see changed=false except for the first writer when the row is missing.

import { getDb } from "@/lib/db";

const now = () => new Date().toISOString();

export interface ChangeRecord {
  /** True iff the stored fingerprint was missing or different. */
  changed: boolean;
  /** Previous fingerprint, or null if the row was new. */
  previous: string | null;
}

/**
 * Records the latest fingerprint observed for (scope, key) and reports
 * whether it differs from the previously stored one. Always upserts.
 */
export function recordSeen(scope: string, key: string, fingerprint: string): ChangeRecord {
  const db = getDb();
  const t = now();
  const prevRow = db
    .prepare("SELECT fingerprint FROM change_tracker WHERE scope=? AND key=?")
    .get(scope, key) as { fingerprint: string } | undefined;
  const previous = prevRow?.fingerprint ?? null;
  const changed = previous !== fingerprint;
  if (changed) {
    db.prepare(
      `INSERT INTO change_tracker (scope, key, fingerprint, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         updated_at  = excluded.updated_at`,
    ).run(scope, key, fingerprint, t);
  }
  return { changed, previous };
}

/** Read the current fingerprint without mutating. */
export function getFingerprint(scope: string, key: string): string | null {
  const row = getDb()
    .prepare("SELECT fingerprint FROM change_tracker WHERE scope=? AND key=?")
    .get(scope, key) as { fingerprint: string } | undefined;
  return row?.fingerprint ?? null;
}

/** Returns true iff fingerprint differs from what's stored — no write. */
export function hasChanged(scope: string, key: string, fingerprint: string): boolean {
  return getFingerprint(scope, key) !== fingerprint;
}

/** Delete a single (scope, key) entry. Returns whether a row was removed. */
export function clearKey(scope: string, key: string): boolean {
  const r = getDb().prepare("DELETE FROM change_tracker WHERE scope=? AND key=?").run(scope, key);
  return r.changes > 0;
}

/** Delete every entry in a scope. Useful when a source is removed. */
export function clearScope(scope: string): number {
  const r = getDb().prepare("DELETE FROM change_tracker WHERE scope=?").run(scope);
  return Number(r.changes);
}

/** Diagnostic / test helper — lists every (key, fingerprint) in a scope. */
export function listScope(scope: string): Array<{ key: string; fingerprint: string; updated_at: string }> {
  return getDb()
    .prepare("SELECT key, fingerprint, updated_at FROM change_tracker WHERE scope=? ORDER BY key")
    .all(scope) as unknown as Array<{ key: string; fingerprint: string; updated_at: string }>;
}
