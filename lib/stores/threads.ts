import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { withDbTransaction } from "@/lib/db/transaction";
import { processMessageEmbeddingJobs, resetMessageEmbedCache, resetMemoryEmbedCache } from "@/lib/embeddings";
import { enqueueMessageEmbeddingJob } from "./message-embedding-jobs";
import { CHAT_ARCHIVE_NAMESPACE, makeChatArchiveKey } from "./chat-archive-key";
export { CHAT_ARCHIVE_NAMESPACE, makeChatArchiveKey, parseChatArchiveKey } from "./chat-archive-key";

const now = () => new Date().toISOString();

// Explicit column list for message reads — omits `embedding` (~20KB of
// JSON-encoded float[] per row) which only the embeddings module reads.
// Avoids dragging it through the chat-history result set on every call.
// `rowid` (aliased `seq`) is SQLite's own monotonic insertion-order integer —
// every rowid table has one for free, no migration needed. It's the only
// reliable ordering key: `created_at` is wall-clock and can collide within
// the same millisecond on a fast burst (see addMessage below).
const MSG_COLS_SQL = "SELECT rowid AS seq, msg_id, thread_id, role, content, created_at, tool_events, category, metadata FROM messages";

// Categories carrying only automation/background activity — never part of
// the "foreground" conversation view and never folded into the warm summary
// that authorizes pruneThreadMessages's destructive delete. This list is the
// single source of truth for both: getRecentMessagesWindow's "foreground"
// scope and pruneThreadMessages's categoryGuard build their SQL from it, so
// they can't silently diverge (a category excluded from one but not the
// other would mean a row gets pruned before ever being summarized, or vice
// versa). Exported so tests can assert both call sites stay in lockstep.
export const FOREGROUND_EXCLUDED_CATEGORIES = ["scheduled_task", "watcher", "bridge"] as const;

// `category IS NULL OR category NOT IN (...)`, built from
// FOREGROUND_EXCLUDED_CATEGORIES with `?` placeholders so callers append the
// values to their own params array in the same position the clause lands.
function foregroundCategoryGuardSql(): string {
  const placeholders = FOREGROUND_EXCLUDED_CATEGORIES.map(() => "?").join(",");
  return `(category IS NULL OR category NOT IN (${placeholders}))`;
}

export interface ThreadRow {
  thread_id: string; agent_id: string; title: string | null;
  created_at: string; updated_at: string; message_count: number;
  // ADR-0096 — explicit source cursor + cached warm summary. NULL on threads
  // that haven't had the boundary moved away from the agent default. The
  // summary is fresh only when warm_summary_before_seq === hot_since_seq.
  hot_since?: string | null;
  hot_since_seq?: number | null;
  warm_summary?: string | null;
  warm_summary_before?: string | null;
  warm_summary_before_seq?: number | null;
  warm_summary_computed_at?: string | null;
  // Compaction-stat columns — set alongside warm_summary. Null when the
  // summary predates these columns or was computed in a path that doesn't
  // know the source counts.
  warm_summary_source_messages?: number | null;
  warm_summary_source_chars?: number | null;
  // JSON-encoded SummaryTopicSegment[] (see lib/agents/conversation-summary.ts)
  // covering the same range as warm_summary_before. NULL when the summarizer
  // didn't return a topics fence, or on legacy rows.
  warm_summary_topics?: string | null;
  // Auto boundary detection is suppressed while message_count is below this
  // value. Set once by moveThreadContextBoundary on a user-initiated move;
  // 0 = no active suppression.
  auto_boundary_locked_until_msg_count?: number;
}
export interface MessageRow {
  // SQLite rowid — strictly increasing insertion order, unique per row.
  // The canonical sort/pagination key; created_at is display-only.
  seq: number;
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

// Tool names the agent called in this thread, most recent first. Includes
// targets reached through invoke_tool so proxied tools count as used.
export function getRecentlyUsedToolNames(thread_id: string, maxRows = 25): string[] {
  const rows = getDb()
    .prepare("SELECT tool_events FROM messages WHERE thread_id=? AND tool_events IS NOT NULL ORDER BY rowid DESC LIMIT ?")
    .all(thread_id, maxRows) as Array<{ tool_events: string }>;
  const seen = new Set<string>();
  for (const row of rows) {
    let events: PersistedToolEvent[];
    try {
      events = JSON.parse(row.tool_events) as PersistedToolEvent[];
    } catch {
      continue;
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.phase !== "call" || typeof event.name !== "string") continue;
      const proxied = event.name === "invoke_tool" && event.payload && typeof event.payload === "object"
        ? (event.payload as { name?: unknown }).name
        : undefined;
      seen.add(typeof proxied === "string" && proxied ? proxied : event.name);
    }
  }
  return [...seen];
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

export function getThreadMessageBySeq(thread_id: string, seq: number): MessageRow | null {
  return (getDb().prepare(MSG_COLS_SQL + " WHERE thread_id=? AND rowid=?").get(thread_id, seq) as unknown as MessageRow | undefined) ?? null;
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
  const deleted = withDbTransaction(() => {
    db.prepare("DELETE FROM messages WHERE thread_id=?").run(thread_id);
    const r = db.prepare("DELETE FROM threads WHERE thread_id=?").run(thread_id);
    return r.changes > 0;
  });
  resetMessageEmbedCache();
  return deleted;
}

export function getMessages(thread_id: string): MessageRow[] {
  return getDb()
    .prepare(MSG_COLS_SQL + " WHERE thread_id=? ORDER BY rowid ASC")
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
  scope: "foreground" | "bridge" | "all" | "none" | "channels" = "all",
  bridgeKey?: string,
  // ADR-0044 — active channel set for scope="channels". "chat" means
  // category IS NULL (the pseudo-channel); any other entry must be one of
  // FOREGROUND_EXCLUDED_CATEGORIES. An empty/omitted list degenerates to
  // "no rows" rather than silently falling back to "all".
  channels?: readonly string[],
  sinceSeq?: number,
): MessageRow[] {
  if (scope === "none") return [];
  const db = getDb();
  const params: (string | number)[] = [thread_id];
  // Exclude `run_error` marker rows from the LLM history window — they're
  // UI-only artefacts of failed turns and would poison the model's view
  // of the conversation ("assistant: 400 API_KEY_INVALID"). See ADR-0069.
  let sql = MSG_COLS_SQL
    + " WHERE thread_id=?"
    + " AND (category IS NULL OR category != 'run_error')"
    + ` AND (metadata IS NULL OR instr(metadata, '"automation_activity"') = 0)`;
  if (scope === "foreground") {
    sql += " AND " + foregroundCategoryGuardSql();
    params.push(...FOREGROUND_EXCLUDED_CATEGORIES);
  } else if (scope === "bridge") {
    if (!bridgeKey) return [];
    sql += " AND category='bridge' AND json_extract(metadata, '$.bridge_conversation.key')=?";
    params.push(bridgeKey);
  } else if (scope === "channels") {
    const active = channels ?? [];
    const includesChat = active.includes("chat");
    const extra = active.filter((c) => c !== "chat");
    const clauses: string[] = [];
    if (includesChat) clauses.push("category IS NULL");
    if (extra.length > 0) clauses.push(`category IN (${extra.map(() => "?").join(",")})`);
    if (clauses.length === 0) return []; // no active channel — nothing qualifies
    sql += " AND (" + clauses.join(" OR ") + ")";
    params.push(...extra);
  }
  if (sinceSeq !== undefined) {
    sql += " AND rowid >= ?";
    params.push(sinceSeq);
  } else if (sinceISO) {
    sql += " AND created_at >= ?";
    params.push(sinceISO);
  }
  sql += " ORDER BY rowid DESC";
  if (limit > 0) {
    sql += " LIMIT ?";
    params.push(limit);
  }
  const rows = db.prepare(sql).all(...params) as unknown as MessageRow[];
  return rows.reverse();
}

export function countMessagesBetweenSeq(
  thread_id: string,
  fromSeq: number,
  toSeq: number,
  scope: "foreground" | "bridge" | "all",
  limit: number,
): number {
  if (toSeq <= fromSeq) return 0;
  const params: (string | number)[] = [thread_id, fromSeq, toSeq];
  let sql = "SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages"
    + " WHERE thread_id=? AND rowid >= ? AND rowid < ?"
    + " AND (category IS NULL OR category != 'run_error')"
    + ` AND (metadata IS NULL OR instr(metadata, '"automation_activity"') = 0)`;
  if (scope === "foreground") {
    sql += " AND " + foregroundCategoryGuardSql();
    params.push(...FOREGROUND_EXCLUDED_CATEGORIES);
  } else if (scope === "bridge") {
    sql += " AND category='bridge'";
  }
  sql += " LIMIT ?)";
  params.push(limit);
  const row = getDb().prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

// Forward-fetch — return messages strictly newer than `afterSeq`, oldest
// first, capped at `limit`. Used by the chat view to pull only the
// freshly-persisted user+assistant pair after a run completes, instead of
// re-fetching the whole most-recent page.
export function getMessagesAfter(
  thread_id: string,
  afterSeq: number,
  limit = 50,
): MessageRow[] {
  return getDb()
    .prepare(
      MSG_COLS_SQL +
        " WHERE thread_id=? AND rowid > ? ORDER BY rowid ASC LIMIT ?",
    )
    .all(thread_id, afterSeq, limit) as unknown as MessageRow[];
}

// Pagination for the chat UI. Returns the latest N messages strictly older
// than `beforeSeq` (cursor). Caller passes the oldest already-loaded
// message's `seq` as the cursor; first page omits beforeSeq.
export function getMessagesPage(
  thread_id: string,
  limit: number,
  beforeSeq?: number,
): { messages: MessageRow[]; has_more: boolean } {
  const db = getDb();
  const params: (string | number)[] = [thread_id];
  let sql = MSG_COLS_SQL + " WHERE thread_id=?";
  if (beforeSeq !== undefined) {
    sql += " AND rowid < ?";
    params.push(beforeSeq);
  }
  sql += " ORDER BY rowid DESC LIMIT ?";
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
  const db = getDb();
  const t = now();
  const toolEventsJson = toolEvents && toolEvents.length > 0 ? JSON.stringify(toolEvents) : null;
  const metadataJson = metadata && Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
  const seq = withDbTransaction(() => {
    const info = db.prepare("INSERT INTO messages (msg_id,thread_id,role,content,created_at,tool_events,category,metadata) VALUES (?,?,?,?,?,?,?,?)")
      .run(msg_id, thread_id, role, content, t, toolEventsJson, category, metadataJson);
    db.prepare("UPDATE threads SET message_count=message_count+1 WHERE thread_id=?").run(thread_id);
    enqueueMessageEmbeddingJob(msg_id, content);
    return Number(info.lastInsertRowid);
  });
  scheduleMessageEmbeddingWorker();
  return { seq, msg_id, thread_id, role, content, created_at: t, tool_events: toolEventsJson, category, metadata: metadataJson };
}

function scheduleMessageEmbeddingWorker(): void {
  queueMicrotask(() => {
    void processMessageEmbeddingJobs().catch((err) => console.warn("[embeddings] message queue failed:", err));
  });
}

export function updateMessageContent(
  msg_id: string,
  content: string,
  options: { metadata?: Record<string, unknown> | null; created_at?: string } = {},
): MessageRow | null {
  const db = getDb();
  let contentChanged = false;
  const updated = withDbTransaction(() => {
    const current = db.prepare("SELECT content FROM messages WHERE msg_id=?").get(msg_id) as { content: string } | undefined;
    if (!current) return null;
    contentChanged = current.content !== content;
    const assignments = ["content=?"];
    const values: Array<string | null> = [content];
    if (contentChanged) assignments.push("embedding=NULL");
    if (Object.hasOwn(options, "metadata")) {
      assignments.push("metadata=?");
      const metadata = options.metadata;
      values.push(metadata && Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null);
    }
    if (options.created_at !== undefined) {
      assignments.push("created_at=?");
      values.push(options.created_at);
    }
    values.push(msg_id);
    db.prepare(`UPDATE messages SET ${assignments.join(", ")} WHERE msg_id=?`).run(...values);
    if (contentChanged) enqueueMessageEmbeddingJob(msg_id, content, true);
    return db.prepare(MSG_COLS_SQL + " WHERE msg_id=?").get(msg_id) as unknown as MessageRow;
  });
  if (contentChanged) {
    resetMessageEmbedCache();
    scheduleMessageEmbeddingWorker();
  }
  return updated;
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
// thread and delete the rest. When preserveFromSeq is supplied, every
// message at or after that `seq` cursor is retained because the warm
// summary only covers rows before it. Uses `seq` rather than created_at so
// a same-millisecond collision at the exact boundary can't leave a row
// stuck — neither summarized nor pruned (see ADR-0088).
//
// The preserveFromSeq path never deletes scheduled_task/watcher/bridge rows,
// even when they're before the cursor: the warm summary that authorizes this
// destructive prune is built from getRecentMessagesWindow's "foreground"
// scope, which excludes exactly those categories (ADR-0044's channel
// isolation). Deleting them here would destroy automation-channel history
// nothing else has folded into a summary.
//
// Before deleting, each pruned chat row (role in user/assistant, with an
// existing embedding) is copied into memory_store at the chat_archive
// namespace so semantic recall can still surface it after compaction.
export function pruneThreadMessages(threadId: string, keepLast: number, preserveFromSeq?: number): number {
  if (!Number.isFinite(keepLast) || keepLast <= 0) return 0;
  const db = getDb();
  const categoryGuard = " AND " + foregroundCategoryGuardSql();
  const totalQuery = preserveFromSeq !== undefined
    ? "SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND rowid < ?" + categoryGuard
    : "SELECT COUNT(*) AS n FROM messages WHERE thread_id=?";
  const total = (db
    .prepare(totalQuery)
    .get(...(preserveFromSeq !== undefined ? [threadId, preserveFromSeq, ...FOREGROUND_EXCLUDED_CATEGORIES] : [threadId])) as { n: number } | undefined)?.n ?? 0;
  if (total <= keepLast) return 0;
  const removeCount = preserveFromSeq !== undefined ? total : total - keepLast;
  const deleteSql = preserveFromSeq !== undefined
    ? "DELETE FROM messages WHERE msg_id IN (" +
      "  SELECT msg_id FROM messages WHERE thread_id=? AND rowid < ?" + categoryGuard + " ORDER BY rowid ASC LIMIT ?" +
      ")"
    : "DELETE FROM messages WHERE msg_id IN (" +
      "  SELECT msg_id FROM messages WHERE thread_id=? ORDER BY rowid ASC LIMIT ?" +
      ")";
  // Fetch the rows we're about to delete so we can archive the embedded
  // chat ones first. Automation rows and non-chat roles are skipped —
  // they are not transcript content the user would want surfaced via
  // recall. The SELECT mirrors the DELETE's filter exactly so archive and
  // delete operate on the same set of victims.
  const victimSelectSql = preserveFromSeq !== undefined
    ? "SELECT msg_id, role, content, embedding, created_at FROM messages WHERE thread_id=? AND rowid < ?" + categoryGuard + " ORDER BY rowid ASC LIMIT ?"
    : "SELECT msg_id, role, content, embedding, created_at FROM messages WHERE thread_id=? ORDER BY rowid ASC LIMIT ?";
  const victims = db.prepare(victimSelectSql).all(
    ...(preserveFromSeq !== undefined
      ? [threadId, preserveFromSeq, ...FOREGROUND_EXCLUDED_CATEGORIES, removeCount]
      : [threadId, removeCount]),
  ) as Array<{ msg_id: string; role: string; content: string; embedding: string | null; created_at: string }>;
  const nowIso = new Date().toISOString();
  const archiveInsert = db.prepare(
    "INSERT OR REPLACE INTO memory_store (namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,?)",
  );
  let archivedCount = 0;
  for (const row of victims) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    if (!row.embedding) continue;
    archiveInsert.run(
      CHAT_ARCHIVE_NAMESPACE,
      makeChatArchiveKey(row.role, threadId, row.msg_id),
      row.content,
      row.created_at,
      nowIso,
      row.embedding,
    );
    archivedCount += 1;
  }
  // Drop the in-memory recall cache so the next recall() picks up the
  // batch — matches the resetMessageEmbedCache pattern below for the
  // delete side of the same operation.
  if (archivedCount > 0) resetMemoryEmbedCache();
  const r = db
    .prepare(deleteSql)
    .run(...(preserveFromSeq !== undefined
      ? [threadId, preserveFromSeq, ...FOREGROUND_EXCLUDED_CATEGORIES, removeCount]
      : [threadId, removeCount]));
  const removed = Number(r.changes);
  db.prepare("UPDATE threads SET message_count=?, updated_at=? WHERE thread_id=?")
    .run(Math.max(0, total - removed), new Date().toISOString(), threadId);
  if (removed > 0) resetMessageEmbedCache();
  return removed;
}

// Rows belonging to one automation channel (ADR-0044). Unlike "foreground"
// scope (which excludes ALL of FOREGROUND_EXCLUDED_CATEGORIES), this fetches
// exactly one of them — the messages a per-channel warm summary for that
// channel needs to cover. `category` must be a member of
// FOREGROUND_EXCLUDED_CATEGORIES; the "chat" pseudo-channel (category IS
// NULL) is covered by getRecentMessagesWindow's existing "foreground" scope
// and has no separate function here.
export function getMessagesByAutomationCategory(threadId: string, category: string): MessageRow[] {
  if (!(FOREGROUND_EXCLUDED_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(`getMessagesByAutomationCategory: "${category}" is not an automation channel`);
  }
  return getDb()
    .prepare(MSG_COLS_SQL + " WHERE thread_id=? AND category=? ORDER BY rowid ASC")
    .all(threadId, category) as unknown as MessageRow[];
}

export interface ThreadChannelSummaryRow {
  thread_id: string;
  channel: string;
  summary: string;
  summary_before: string | null;
  summary_before_seq: number | null;
  computed_at: string;
}

// ADR-0044 — one cached warm summary per (thread, automation channel),
// alongside the legacy single `threads.warm_summary*` columns which remain
// the "chat" channel's summary (see history-window.ts). No optimistic-
// concurrency guard: two concurrent computations for the same channel+
// boundary produce the same content from the same source rows, so a race
// costs at most one duplicate LLM call, not corruption — unlike the shared
// hot/warm boundary move, there's no cross-field invariant to protect here.
export function getThreadChannelSummary(threadId: string, channel: string): ThreadChannelSummaryRow | null {
  return (getDb()
    .prepare("SELECT thread_id, channel, summary, summary_before, summary_before_seq, computed_at FROM thread_channel_summaries WHERE thread_id=? AND channel=?")
    .get(threadId, channel) as ThreadChannelSummaryRow | undefined) ?? null;
}

export function commitThreadChannelSummary(
  threadId: string,
  channel: string,
  input: { summary: string; summaryBefore: string | null; summaryBeforeSeq?: number | null },
): void {
  if (input.summaryBefore !== null && input.summaryBeforeSeq == null) {
    throw new Error("summaryBeforeSeq is required for a boundary summary");
  }
  getDb()
    .prepare(
      `INSERT INTO thread_channel_summaries (thread_id, channel, summary, summary_before, summary_before_seq, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, channel) DO UPDATE SET
         summary=excluded.summary, summary_before=excluded.summary_before,
         summary_before_seq=excluded.summary_before_seq, computed_at=excluded.computed_at`,
    )
    .run(threadId, channel, input.summary, input.summaryBefore, input.summaryBeforeSeq ?? null, now());
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
export function setThreadContextPin(thread_id: string, hot_since: string | null, hot_since_seq?: number | null): void {
  if (hot_since !== null && hot_since_seq == null) {
    throw new Error("hot_since_seq is required for a context pin");
  }
  getDb()
    .prepare("UPDATE threads SET hot_since=?, hot_since_seq=? WHERE thread_id=?")
    .run(hot_since, hot_since === null ? null : hot_since_seq!, thread_id);
}

// Called by moveThreadContextBoundary whenever the user explicitly moves the
// boundary (drag, or manual /compact) — never by the auto-detector's own
// commit path, which calls setThreadContextPin directly. `untilMessageCount`
// is a one-time write; the read side (lib/agents/run-thread.ts) just compares
// against it, no per-turn write needed.
export function setAutoBoundaryLock(thread_id: string, untilMessageCount: number): void {
  getDb()
    .prepare("UPDATE threads SET auto_boundary_locked_until_msg_count=? WHERE thread_id=?")
    .run(Math.max(0, untilMessageCount), thread_id);
}

export interface ThreadWarmContextCommit {
  hotSince: string;
  hotSinceSeq: number;
  summary: string;
  sourceMessages: number;
  sourceChars: number;
  topics?: string | null;
  expectedHotSinceSeq?: number | null;
  /** Reject the commit if another compactor refreshed the same boundary. */
  expectedWarmSummary?: string | null;
  autoBoundaryLockedUntilMessageCount?: number;
  channelSummaries?: Array<{ channel: string; summary: string }>;
}

// A warm recap is only valid for the exact boundary it replaced. Commit both
// fields in one SQLite transaction so a model call can never leave the thread
// between a new hot pin and its corresponding warm context.
export function commitThreadWarmContext(
  thread_id: string,
  input: ThreadWarmContextCommit,
): ThreadRow | null {
  const db = getDb();
  const checkExpectedPinSeq = Object.hasOwn(input, "expectedHotSinceSeq");
  const checkExpectedSummary = Object.hasOwn(input, "expectedWarmSummary");
  const hotSinceSeq = input.hotSinceSeq;
  if (!Number.isSafeInteger(hotSinceSeq) || hotSinceSeq <= 0) {
    throw new Error("hotSinceSeq must be a positive source cursor");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = getThread(thread_id);
    if (
      !current
      || (checkExpectedPinSeq && (current.hot_since_seq ?? null) !== input.expectedHotSinceSeq)
      || (checkExpectedSummary && (current.warm_summary ?? null) !== input.expectedWarmSummary)
    ) {
      db.exec("ROLLBACK");
      return null;
    }
    db.prepare(
      "UPDATE threads SET hot_since=?, hot_since_seq=?, warm_summary=?, warm_summary_before=?, warm_summary_before_seq=?, warm_summary_computed_at=?, warm_summary_source_messages=?, warm_summary_source_chars=?, warm_summary_topics=?, auto_boundary_locked_until_msg_count=? WHERE thread_id=?",
    ).run(
      input.hotSince,
      hotSinceSeq,
      input.summary,
      input.hotSince,
      hotSinceSeq,
      now(),
      input.sourceMessages,
      input.sourceChars,
      input.topics ?? null,
      input.autoBoundaryLockedUntilMessageCount ?? current.auto_boundary_locked_until_msg_count ?? 0,
      thread_id,
    );
    const upsertChannel = db.prepare(
      `INSERT INTO thread_channel_summaries (thread_id, channel, summary, summary_before, summary_before_seq, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, channel) DO UPDATE SET
         summary=excluded.summary, summary_before=excluded.summary_before,
         summary_before_seq=excluded.summary_before_seq, computed_at=excluded.computed_at`,
    );
    for (const channelSummary of input.channelSummaries ?? []) {
      upsertChannel.run(thread_id, channelSummary.channel, channelSummary.summary, input.hotSince, hotSinceSeq, now());
    }
    db.exec("COMMIT");
    return getThread(thread_id);
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw err;
  }
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
  topics?: string | null,
  beforeSeq?: number | null,
): void {
  if (before !== null && beforeSeq == null) {
    throw new Error("beforeSeq is required for a warm summary");
  }
  getDb()
    .prepare(
      "UPDATE threads SET warm_summary=?, warm_summary_before=?, warm_summary_before_seq=?, warm_summary_computed_at=?, warm_summary_source_messages=?, warm_summary_source_chars=?, warm_summary_topics=? WHERE thread_id=?",
    )
    .run(
      summary,
      before,
      before === null ? null : beforeSeq!,
      now(),
      typeof sourceMessages === "number" ? sourceMessages : null,
      typeof sourceChars === "number" ? sourceChars : null,
      topics ?? null,
      thread_id,
    );
}
