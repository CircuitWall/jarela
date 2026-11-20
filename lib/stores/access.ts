import { getDb } from "@/lib/db";
import { getOrCreateGlobal } from "@/lib/utils/global-state";

const now = () => new Date().toISOString();

// `last_seen_at` is a coarse "still active" marker, but it is written from the
// auth check that runs on every tailnet request. Each write takes the WAL write
// lock and fsyncs, and a single-row update was measured at 500ms under load —
// a 500ms event-loop stall for a display-only timestamp. Record it at most
// once per window per identity.
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

function lastSeenWrites(): Map<string, number> {
  return getOrCreateGlobal<Map<string, number>>("__jarela_access_last_seen_writes", () => new Map());
}

/** Test seam: forget the write throttle so the next call writes again. */
export function __resetLastSeenThrottleForTests(): void {
  lastSeenWrites().clear();
}

export interface WhitelistEntry {
  identity: string;
  display_name: string | null;
  added_at: string;
  last_seen_at: string | null;
}

export function listWhitelist(): WhitelistEntry[] {
  return getDb()
    .prepare("SELECT * FROM access_whitelist ORDER BY added_at ASC")
    .all() as unknown as WhitelistEntry[];
}

export function addToWhitelist(identity: string, displayName?: string | null): WhitelistEntry {
  const trimmed = identity.trim();
  if (!trimmed) throw new Error("identity is required");
  getDb()
    .prepare(
      `INSERT INTO access_whitelist (identity, display_name, added_at, last_seen_at)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(identity) DO UPDATE SET display_name=excluded.display_name`,
    )
    .run(trimmed, displayName?.trim() || null, now());
  return getDb()
    .prepare("SELECT * FROM access_whitelist WHERE identity=?")
    .get(trimmed) as unknown as WhitelistEntry;
}

export function removeFromWhitelist(identity: string): void {
  getDb().prepare("DELETE FROM access_whitelist WHERE identity=?").run(identity);
}

export function isWhitelisted(identity: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM access_whitelist WHERE identity=?")
    .get(identity);
  return !!row;
}

export function touchLastSeen(identity: string): void {
  const writes = lastSeenWrites();
  const nowMs = Date.now();
  const previous = writes.get(identity);
  if (previous !== undefined && nowMs - previous < LAST_SEEN_WRITE_INTERVAL_MS) return;
  writes.set(identity, nowMs);
  try {
    getDb()
      .prepare("UPDATE access_whitelist SET last_seen_at=? WHERE identity=?")
      .run(now(), identity);
  } catch {
    // best-effort — never let this fail a request; retry on the next call
    writes.delete(identity);
  }
}
