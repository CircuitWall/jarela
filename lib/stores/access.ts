import { getDb } from "@/lib/db";

const now = () => new Date().toISOString();

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
  try {
    getDb()
      .prepare("UPDATE access_whitelist SET last_seen_at=? WHERE identity=?")
      .run(now(), identity);
  } catch {
    // best-effort — never let this fail a request
  }
}
