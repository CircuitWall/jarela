// Per-project Copilot session id for `copilot_delegate` (ADR-0120).
//
// The Copilot SDK persists session state on disk; this store only remembers
// which session belongs to a workspace/feature so follow-up calls resume the
// same conversation instead of rebuilding context. Stored through the shared
// memory store rather than a dedicated table: the value is a non-secret id and
// no schema migration is worth a new table for it.

import { getDb } from "@/lib/db";

const NAMESPACE = "copilot-delegate-sessions";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredSession { session_id?: unknown; updated_at?: unknown }

export function getCopilotSession(projectKey: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM memory_store WHERE namespace=? AND key=?")
    .get(NAMESPACE, projectKey) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as StoredSession;
    if (typeof parsed.session_id !== "string" || !parsed.session_id) return null;
    const updated = typeof parsed.updated_at === "string" ? Date.parse(parsed.updated_at) : Number.NaN;
    if (Number.isNaN(updated) || Date.now() - updated > SESSION_TTL_MS) return null;
    return parsed.session_id;
  } catch {
    return null;
  }
}

export function rememberCopilotSession(projectKey: string, sessionId: string): void {
  const db = getDb();
  const timestamp = new Date().toISOString();
  const value = JSON.stringify({ session_id: sessionId, updated_at: timestamp });
  db.prepare(
    `INSERT INTO memory_store (namespace, key, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(namespace, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(NAMESPACE, projectKey, value, timestamp, timestamp);
  db.prepare("DELETE FROM memory_store WHERE namespace=? AND updated_at < ?")
    .run(NAMESPACE, new Date(Date.now() - SESSION_TTL_MS).toISOString());
}

export function forgetCopilotSession(projectKey: string): void {
  getDb().prepare("DELETE FROM memory_store WHERE namespace=? AND key=?").run(NAMESPACE, projectKey);
}
