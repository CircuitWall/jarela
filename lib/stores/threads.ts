import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { embedOne } from "@/lib/embeddings";

const now = () => new Date().toISOString();

// Explicit column list for message reads — omits `embedding` (~20KB of
// JSON-encoded float[] per row) which only the embeddings module reads.
// Avoids dragging it through the chat-history result set on every call.
const MSG_COLS_SQL = "SELECT msg_id, thread_id, role, content, created_at, tool_events, category, metadata FROM messages";

export interface ThreadRow {
  thread_id: string; agent_id: string; title: string | null;
  created_at: string; updated_at: string; message_count: number;
  // ADR-0042 — explicit context pin + cached warm summary. NULL on threads
  // that haven't had the boundary moved away from the agent default. The
  // summary is fresh only when warm_summary_before === hot_since.
  hot_since?: string | null;
  warm_summary?: string | null;
  warm_summary_before?: string | null;
  warm_summary_computed_at?: string | null;
  // Compaction-stat columns — set alongside warm_summary. Null when the
  // summary predates these columns or was computed in a path that doesn't
  // know the source counts.
  warm_summary_source_messages?: number | null;
  warm_summary_source_chars?: number | null;
}
export interface MessageRow {
  msg_id: string; thread_id: string; role: string; content: string; created_at: string;
  // JSON-encoded array of PersistedToolEvent. null when no tool work happened
  // on this turn or for user messages. Read back by the chat UI so historical
  // bubbles show the same expandable CALL/RESULT entries as live streaming.
  tool_events?: string | null;
  // Non-null tags classify the message into a filterable group in the chat
  // panel (e.g. 'scheduled_task', 'bridge', 'synthetic'). NULL = ordinary
  // user/assistant chat content.
  category?: string | null;
  // JSON-encoded auxiliary per-message data. NULL on legacy rows. Currently
  // carries the citation-checker verdict when the agent's `citation_strictness`
  // is not `off`.
  metadata?: string | null;
}

export interface PersistedToolEvent {
  id: string;
  phase: "call" | "result";
  name: string;
  payload: unknown;
}

export function listThreads(limit = 50, offset = 0): ThreadRow[] {
  return getDb()
    .prepare("SELECT * FROM threads ORDER BY updated_at DESC LIMIT ? OFFSET ?")
    .all(limit, offset) as unknown as ThreadRow[];
}

export function listThreadsByAgent(agent_id: string, limit = 50): ThreadRow[] {
  return getDb()
    .prepare("SELECT * FROM threads WHERE agent_id=? ORDER BY updated_at DESC LIMIT ?")
    .all(agent_id, limit) as unknown as ThreadRow[];
}

export function getThread(thread_id: string): ThreadRow | null {
  return (getDb().prepare("SELECT * FROM threads WHERE thread_id=?").get(thread_id) as unknown as ThreadRow) ?? null;
}

export function createThread(agent_id: string, title?: string): ThreadRow {
  const existing = getDb()
    .prepare("SELECT * FROM threads WHERE agent_id=? LIMIT 1")
    .get(agent_id) as ThreadRow | undefined;
  if (existing) return existing;

  const t = now();
  const thread_id = randomUUID();
  getDb()
    .prepare("INSERT INTO threads (thread_id,agent_id,title,created_at,updated_at,message_count) VALUES (?,?,?,?,?,0)")
    .run(thread_id, agent_id, title ?? null, t, t);
  return { thread_id, agent_id, title: title ?? null, created_at: t, updated_at: t, message_count: 0 };
}

export function deleteThread(thread_id: string): boolean {
  const db = getDb();
  db.prepare("DELETE FROM messages WHERE thread_id=?").run(thread_id);
  const r = db.prepare("DELETE FROM threads WHERE thread_id=?").run(thread_id);
  return r.changes > 0;
}

export function getMessages(thread_id: string): MessageRow[] {
  return getDb()
    .prepare(MSG_COLS_SQL + " WHERE thread_id=? ORDER BY created_at ASC")
    .all(thread_id) as unknown as MessageRow[];
}

// Pull the latest N messages within a time window. Used to build the LLM
// context — keeps prompt size bounded as threads grow indefinitely.
//   limit: 0 or negative = unlimited
//   sinceISO: undefined = no time bound
// Returns chronological order (oldest first) so it can be appended to the prompt directly.
export function getRecentMessagesWindow(
  thread_id: string,
  limit: number,
  sinceISO?: string,
): MessageRow[] {
  const db = getDb();
  const params: (string | number)[] = [thread_id];
  // Exclude `run_error` marker rows from the LLM history window — they're
  // UI-only artefacts of failed turns and would poison the model's view
  // of the conversation ("assistant: 400 API_KEY_INVALID"). See ADR-0069.
  let sql = MSG_COLS_SQL + " WHERE thread_id=? AND (category IS NULL OR category != 'run_error')";
  if (sinceISO) {
    sql += " AND created_at >= ?";
    params.push(sinceISO);
  }
  sql += " ORDER BY created_at DESC";
  if (limit > 0) {
    sql += " LIMIT ?";
    params.push(limit);
  }
  const rows = db.prepare(sql).all(...params) as unknown as MessageRow[];
  return rows.reverse();
}

// Forward-fetch — return messages strictly newer than `afterISO`, oldest
// first, capped at `limit`. Used by the chat view to pull only the
// freshly-persisted user+assistant pair after a run completes, instead of
// re-fetching the whole most-recent page.
export function getMessagesAfter(
  thread_id: string,
  afterISO: string,
  limit = 50,
): MessageRow[] {
  return getDb()
    .prepare(
      MSG_COLS_SQL +
        " WHERE thread_id=? AND created_at > ? ORDER BY created_at ASC LIMIT ?",
    )
    .all(thread_id, afterISO, limit) as unknown as MessageRow[];
}

// Pagination for the chat UI. Returns the latest N messages strictly older
// than `beforeISO` (cursor). Caller passes the oldest already-loaded message's
// created_at as the cursor; first page omits beforeISO.
export function getMessagesPage(
  thread_id: string,
  limit: number,
  beforeISO?: string,
): { messages: MessageRow[]; has_more: boolean } {
  const db = getDb();
  const params: (string | number)[] = [thread_id];
  let sql = MSG_COLS_SQL + " WHERE thread_id=?";
  if (beforeISO) {
    sql += " AND created_at < ?";
    params.push(beforeISO);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit + 1); // fetch one extra to detect if there's more
  const rows = db.prepare(sql).all(...params) as unknown as MessageRow[];
  const has_more = rows.length > limit;
  return { messages: rows.slice(0, limit).reverse(), has_more };
}

export function addMessage(
  thread_id: string,
  role: "user" | "assistant",
  content: string,
  toolEvents?: PersistedToolEvent[] | null,
  category: string | null = null,
  metadata?: Record<string, unknown> | null,
): MessageRow {
  const msg_id = randomUUID();
  const t = now();
  const db = getDb();
  const toolEventsJson = toolEvents && toolEvents.length > 0 ? JSON.stringify(toolEvents) : null;
  const metadataJson = metadata && Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
  db.prepare("INSERT INTO messages (msg_id,thread_id,role,content,created_at,tool_events,category,metadata) VALUES (?,?,?,?,?,?,?,?)")
    .run(msg_id, thread_id, role, content, t, toolEventsJson, category, metadataJson);
  db.prepare("UPDATE threads SET message_count=message_count+1 WHERE thread_id=?").run(thread_id);
  // Best-effort: embed the message so semantic recall can pull it back later.
  // Skip empty / very short content (greetings have no useful signal).
  if (content.trim().length >= 12) {
    embedOne(content).then((vec) => {
      if (vec) {
        getDb().prepare("UPDATE messages SET embedding=? WHERE msg_id=?").run(JSON.stringify(vec), msg_id);
      }
    }).catch(() => { /* logged in embeddings module */ });
  }
  return { msg_id, thread_id, role, content, created_at: t, tool_events: toolEventsJson, category, metadata: metadataJson };
}

// Shallow-merge `partial` into a message's existing metadata. Use this
// when multiple subsystems own different fields on the same row
// (e.g. citations and redaction_summary) — each can write independently
// without clobbering the other. Existing keys in `partial` overwrite
// the same keys in stored metadata; null clears the field.
export function mergeMessageMetadata(
  msg_id: string,
  partial: Record<string, unknown>,
): void {
  const row = getDb()
    .prepare("SELECT metadata FROM messages WHERE msg_id=?")
    .get(msg_id) as { metadata?: string | null } | undefined;
  let existing: Record<string, unknown> = {};
  if (row?.metadata) {
    try {
      const parsed = JSON.parse(row.metadata);
      if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
    } catch { /* fall through with empty object */ }
  }
  const merged: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(partial)) {
    if (v === null || v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const json = Object.keys(merged).length > 0 ? JSON.stringify(merged) : null;
  getDb().prepare("UPDATE messages SET metadata=? WHERE msg_id=?").run(json, msg_id);
}

export function getOrCreateAgentThread(agentId: string): ThreadRow {
  return createThread(agentId);
}

// Retention guardrail: keep at most `keepLast` most-recent messages on a
// thread and delete the rest. Used by /compact so /new doesn't grow the
// transcript unboundedly across many compactions. Returns the number of
// rows actually removed (0 if the thread is already within the cap).
export function pruneThreadMessages(threadId: string, keepLast: number): number {
  if (!Number.isFinite(keepLast) || keepLast <= 0) return 0;
  const db = getDb();
  const total = (db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id=?")
    .get(threadId) as { n: number } | undefined)?.n ?? 0;
  if (total <= keepLast) return 0;
  const removeCount = total - keepLast;
  const r = db
    .prepare(
      "DELETE FROM messages WHERE msg_id IN (" +
      "  SELECT msg_id FROM messages WHERE thread_id=? ORDER BY created_at ASC LIMIT ?" +
      ")",
    )
    .run(threadId, removeCount);
  const removed = Number(r.changes);
  db.prepare("UPDATE threads SET message_count=?, updated_at=? WHERE thread_id=?")
    .run(Math.max(0, total - removed), new Date().toISOString(), threadId);
  return removed;
}

export function touchThread(thread_id: string, firstMsg?: string): void {
  const t = now();
  getDb()
    .prepare("UPDATE threads SET updated_at=?, title=COALESCE(title,?) WHERE thread_id=?")
    .run(t, firstMsg ? firstMsg.slice(0, 80) : null, thread_id);
}

// ADR-0042. Move the user's explicit boundary between hot and warm context.
// Pass `null` to clear the pin and let the agent's default window apply
// again. Persisting the pin here keeps it stable across reloads and devices.
export function setThreadContextPin(thread_id: string, hot_since: string | null): void {
  getDb()
    .prepare("UPDATE threads SET hot_since=? WHERE thread_id=?")
    .run(hot_since, thread_id);
}

// Cache the latest warm-tier summary alongside the boundary it covers. The
// chat UI considers the summary fresh only when `warm_summary_before` matches
// the current `hot_since`; any boundary change triggers a re-summarise on the
// next run rather than a synchronous LLM call here.
export function setThreadWarmSummary(
  thread_id: string,
  summary: string,
  before: string | null,
  sourceMessages?: number | null,
  sourceChars?: number | null,
): void {
  getDb()
    .prepare(
      "UPDATE threads SET warm_summary=?, warm_summary_before=?, warm_summary_computed_at=?, warm_summary_source_messages=?, warm_summary_source_chars=? WHERE thread_id=?",
    )
    .run(
      summary,
      before,
      now(),
      typeof sourceMessages === "number" ? sourceMessages : null,
      typeof sourceChars === "number" ? sourceChars : null,
      thread_id,
    );
}
