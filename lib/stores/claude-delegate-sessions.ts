// Per-project Claude Code session id for `claude_delegate` (ADR-0071).
//
// A follow-up `claude_delegate` call against the same project_key resumes
// the same `claude` CLI session (`--resume <session_id>`) instead of
// starting fresh, so the sub-agent accumulates context for that project
// across many separate delegate calls. Replaces the prior external tool's
// hand-rolled JSON sessions file — this repo keeps all persistent state
// in SQLite (`getDb()`).

import { getDb } from "@/lib/db";

const now = (): string => new Date().toISOString();

// Sessions older than this are treated as expired and pruned on the next
// write — matches the TTL the prior external tool used.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function getSession(projectKey: string): string | null {
  const row = getDb()
    .prepare("SELECT session_id, updated_at FROM claude_delegate_sessions WHERE project_key=?")
    .get(projectKey) as { session_id: string; updated_at: string } | undefined;
  if (!row) return null;
  const age = Date.now() - Date.parse(row.updated_at);
  if (Number.isNaN(age) || age > SESSION_TTL_MS) return null;
  return row.session_id;
}

export function rememberSession(projectKey: string, sessionId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO claude_delegate_sessions (project_key, session_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(project_key) DO UPDATE SET session_id=excluded.session_id, updated_at=excluded.updated_at`,
  ).run(projectKey, sessionId, now());
  pruneExpiredSessions(db);
}

function pruneExpiredSessions(db: ReturnType<typeof getDb>): void {
  const cutoff = new Date(Date.now() - SESSION_TTL_MS).toISOString();
  db.prepare("DELETE FROM claude_delegate_sessions WHERE updated_at < ?").run(cutoff);
}
