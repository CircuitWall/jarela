// Per-project Codex session id for `codex_delegate`. Follow-up calls resume
// the same local Codex conversation rather than rebuilding context each time.

import { getDb } from "@/lib/db";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function getSession(projectKey: string): string | null {
  const row = getDb()
    .prepare("SELECT session_id, updated_at FROM codex_delegate_sessions WHERE project_key=?")
    .get(projectKey) as { session_id: string; updated_at: string } | undefined;
  if (!row) return null;
  const age = Date.now() - Date.parse(row.updated_at);
  if (Number.isNaN(age) || age > SESSION_TTL_MS) return null;
  return row.session_id;
}

export function rememberSession(projectKey: string, sessionId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO codex_delegate_sessions (project_key, session_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(project_key) DO UPDATE SET session_id=excluded.session_id, updated_at=excluded.updated_at`,
  ).run(projectKey, sessionId, new Date().toISOString());
  const cutoff = new Date(Date.now() - SESSION_TTL_MS).toISOString();
  db.prepare("DELETE FROM codex_delegate_sessions WHERE updated_at < ?").run(cutoff);
}