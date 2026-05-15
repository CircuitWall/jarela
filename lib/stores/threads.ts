import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { embedOne } from "@/lib/embeddings";

const now = () => new Date().toISOString();

export interface ThreadRow {
  thread_id: string; agent_id: string; title: string | null;
  created_at: string; updated_at: string; message_count: number;
}
export interface MessageRow {
  msg_id: string; thread_id: string; role: string; content: string; created_at: string;
}

export function listThreads(limit = 50, offset = 0): ThreadRow[] {
  return getDb()
    .prepare("SELECT * FROM threads ORDER BY updated_at DESC LIMIT ? OFFSET ?")
    .all(limit, offset) as unknown as ThreadRow[];
}

export function getThread(thread_id: string): ThreadRow | null {
  return (getDb().prepare("SELECT * FROM threads WHERE thread_id=?").get(thread_id) as unknown as ThreadRow) ?? null;
}

export function createThread(agent_id: string, title?: string): ThreadRow {
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
    .prepare("SELECT * FROM messages WHERE thread_id=? ORDER BY created_at ASC")
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
  let sql = "SELECT * FROM messages WHERE thread_id=?";
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
  let sql = "SELECT * FROM messages WHERE thread_id=?";
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

export function addMessage(thread_id: string, role: "user" | "assistant", content: string): MessageRow {
  const msg_id = randomUUID();
  const t = now();
  const db = getDb();
  db.prepare("INSERT INTO messages (msg_id,thread_id,role,content,created_at) VALUES (?,?,?,?,?)")
    .run(msg_id, thread_id, role, content, t);
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
  return { msg_id, thread_id, role, content, created_at: t };
}

export function getOrCreateAgentThread(agentId: string): ThreadRow {
  const existing = getDb()
    .prepare("SELECT * FROM threads WHERE agent_id=? LIMIT 1")
    .get(agentId) as ThreadRow | undefined;
  if (existing) return existing;
  return createThread(agentId);
}

export function clearThreadMessages(threadId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM messages WHERE thread_id=?").run(threadId);
  db.prepare("UPDATE threads SET message_count=0, updated_at=? WHERE thread_id=?")
    .run(new Date().toISOString(), threadId);
}

export function touchThread(thread_id: string, firstMsg?: string): void {
  const t = now();
  getDb()
    .prepare("UPDATE threads SET updated_at=?, title=COALESCE(title,?) WHERE thread_id=?")
    .run(t, firstMsg ? firstMsg.slice(0, 80) : null, thread_id);
}
