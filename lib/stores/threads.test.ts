import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-threads-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { getDb } = await import("@/lib/db");
const { runMigrations } = await import("@/lib/db/migrations");

const {
  addMessage,
  updateMessageContent,
  createThread,
  listThreadsByAgent,
  getMessages,
  getMessagesAfter,
  getMessagesPage,
  getThread,
  commitThreadWarmContext,
  setThreadContextPin,
  setThreadWarmSummary,
  pruneThreadMessages,
  deleteThread,
  listThreads,
  getRecentMessagesWindow,
  getRecentlyUsedToolNames,
  FOREGROUND_EXCLUDED_CATEGORIES,
  getMessagesByAutomationCategory,
  getThreadChannelSummary,
  commitThreadChannelSummary,
} = await import("./threads");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("thread context pin (ADR-0042)", () => {
  beforeEach(() => {
    for (const t of listThreads(1000, 0)) deleteThread(t.thread_id);
  });

  it("createThread is idempotent per agent (one thread per agent)", () => {
    const first = createThread("agent-x", "Primary");
    const second = createThread("agent-x", "Should be ignored");
    expect(second.thread_id).toBe(first.thread_id);
    expect(listThreadsByAgent("agent-x", 10)).toHaveLength(1);
  });

  it("starts with no pin and no cached warm summary", () => {
    const t = createThread("agent-x");
    const fetched = getThread(t.thread_id);
    expect(fetched?.hot_since).toBeFalsy();
    expect(fetched?.warm_summary).toBeFalsy();
    expect(fetched?.warm_summary_before).toBeFalsy();
    expect(fetched?.warm_summary_computed_at).toBeFalsy();
  });

  it("setThreadContextPin moves the boundary and clearing it returns null", () => {
    const t = createThread("agent-x");
    setThreadContextPin(t.thread_id, "2026-06-01T10:00:00.000Z", 1);
    expect(getThread(t.thread_id)?.hot_since).toBe("2026-06-01T10:00:00.000Z");
    expect(getThread(t.thread_id)?.hot_since_seq).toBe(1);
    setThreadContextPin(t.thread_id, null);
    expect(getThread(t.thread_id)?.hot_since).toBeNull();
    expect(getThread(t.thread_id)?.hot_since_seq).toBeNull();
  });

  it("filters the hot window by the exact source seq when timestamps tie", () => {
    const t = createThread("agent-seq-boundary");
    const first = addMessage(t.thread_id, "user", "first tied row");
    const second = addMessage(t.thread_id, "assistant", "pinned tied row");
    const tiedAt = "2026-06-01T10:00:00.000Z";
    getDb().prepare("UPDATE messages SET created_at=? WHERE msg_id IN (?, ?)").run(tiedAt, first.msg_id, second.msg_id);

    setThreadContextPin(t.thread_id, tiedAt, second.seq);
    const hot = getRecentMessagesWindow(t.thread_id, 0, tiedAt, "foreground", undefined, undefined, second.seq);

    expect(getThread(t.thread_id)?.hot_since_seq).toBe(second.seq);
    expect(hot.map((message) => message.content)).toEqual(["pinned tied row"]);
  });

  it("clears legacy timestamp-only pins instead of selecting an ambiguous source row", () => {
    const t = createThread("developer");
    const first = addMessage(t.thread_id, "user", "first tied row");
    addMessage(t.thread_id, "assistant", "second tied row");
    const tiedAt = "2026-06-01T10:00:00.000Z";
    getDb().prepare("UPDATE messages SET created_at=? WHERE thread_id=?").run(tiedAt, t.thread_id);
    getDb().prepare(
      "UPDATE threads SET hot_since=?, hot_since_seq=NULL, warm_summary_before=?, warm_summary_before_seq=NULL WHERE thread_id=?",
    ).run(tiedAt, tiedAt, t.thread_id);
    commitThreadChannelSummary(t.thread_id, "watcher", { summary: "legacy recap", summaryBefore: tiedAt, summaryBeforeSeq: first.seq });
    getDb().prepare("UPDATE thread_channel_summaries SET summary_before_seq=NULL WHERE thread_id=?").run(t.thread_id);

    runMigrations(getDb());

    expect(getThread(t.thread_id)).toBeTruthy();
    expect((getDb().prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).some((column) => column.name === "hot_since_seq")).toBe(true);
    expect(getThread(t.thread_id)?.hot_since).toBeNull();
    expect(getThread(t.thread_id)?.hot_since_seq).toBeNull();
    expect(getThread(t.thread_id)?.warm_summary_before_seq).toBeNull();
    expect(getThreadChannelSummary(t.thread_id, "watcher")?.summary_before_seq).toBeNull();
  });

  it("setThreadWarmSummary stores text + boundary + a computed_at stamp", () => {
    const t = createThread("agent-x");
    setThreadWarmSummary(t.thread_id, "older context recap", "2026-06-01T10:00:00.000Z", undefined, undefined, undefined, 1);
    const after = getThread(t.thread_id);
    expect(after?.warm_summary).toBe("older context recap");
    expect(after?.warm_summary_before).toBe("2026-06-01T10:00:00.000Z");
    // Stamp is wall-clock so we only assert it's a non-empty ISO-ish string.
    expect(typeof after?.warm_summary_computed_at).toBe("string");
    expect((after?.warm_summary_computed_at ?? "").length).toBeGreaterThan(10);
  });

  it("warm summary freshness key: cleared when hot_since changes (caller's responsibility — store just stores)", () => {
    // The store doesn't auto-invalidate; the consumer compares exact seq
    // coverage and overwrites the cursor and summary atomically when they diverge.
    const t = createThread("agent-x");
    setThreadWarmSummary(t.thread_id, "old recap", "2026-06-01T10:00:00.000Z", undefined, undefined, undefined, 1);
    setThreadContextPin(t.thread_id, "2026-06-01T08:00:00.000Z", 2);
    const drifted = getThread(t.thread_id);
    expect(drifted?.hot_since).toBe("2026-06-01T08:00:00.000Z");
    expect(drifted?.warm_summary_before).toBe("2026-06-01T10:00:00.000Z");
    // ⇒ freshness check `warm_summary_before_seq === hot_since_seq` returns false.
  });

  it("commits a hot boundary and its warm summary atomically", () => {
    const t = createThread("agent-x");
    const committed = commitThreadWarmContext(t.thread_id, {
      hotSince: "2026-06-01T10:00:00.000Z",
      hotSinceSeq: 1,
      summary: "<!-- jarela:warm-scope=foreground -->\nolder context recap",
      sourceMessages: 4,
      sourceChars: 120,
      topics: "[]",
      expectedHotSinceSeq: null,
      channelSummaries: [{ channel: "watcher", summary: "watcher recap" }],
    });

    expect(committed?.hot_since).toBe("2026-06-01T10:00:00.000Z");
    expect(committed?.warm_summary_before).toBe("2026-06-01T10:00:00.000Z");
    expect(committed?.warm_summary_source_messages).toBe(4);
    expect(committed?.hot_since_seq).toBe(1);
    expect(committed?.warm_summary_before_seq).toBe(1);
    expect(getThreadChannelSummary(t.thread_id, "watcher")).toMatchObject({
      summary: "watcher recap",
      summary_before_seq: 1,
    });

    setThreadContextPin(t.thread_id, "2026-06-01T11:00:00.000Z", 2);
    const stale = commitThreadWarmContext(t.thread_id, {
      hotSince: "2026-06-01T12:00:00.000Z",
      hotSinceSeq: 3,
      summary: "stale recap",
      sourceMessages: 6,
      sourceChars: 180,
      expectedHotSinceSeq: 1,
      expectedHotSinceSeq: 1,
    });
    expect(stale).toBeNull();
    expect(getThread(t.thread_id)?.hot_since).toBe("2026-06-01T11:00:00.000Z");

    const expectedSummary = getThread(t.thread_id)?.warm_summary ?? null;
    const replacement = commitThreadWarmContext(t.thread_id, {
      hotSince: "2026-06-01T11:00:00.000Z",
      hotSinceSeq: 2,
      summary: "newer recap",
      sourceMessages: 6,
      sourceChars: 180,
      expectedHotSinceSeq: 2,
      expectedHotSinceSeq: 2,
      expectedWarmSummary: expectedSummary,
    });
    expect(replacement?.warm_summary).toBe("newer recap");
    const staleSummary = commitThreadWarmContext(t.thread_id, {
      hotSince: "2026-06-01T11:00:00.000Z",
      hotSinceSeq: 2,
      summary: "must not replace newer recap",
      sourceMessages: 7,
      sourceChars: 210,
      expectedHotSinceSeq: 2,
      expectedHotSinceSeq: 2,
      expectedWarmSummary: expectedSummary,
    });
    expect(staleSummary).toBeNull();
    expect(getThread(t.thread_id)?.warm_summary).toBe("newer recap");
  });
});

describe("addMessage embedding scheduling (issue: image attachments break embedding)", () => {
  beforeEach(() => {
    for (const t of listThreads(1000, 0)) deleteThread(t.thread_id);
  });

  it("queues only the text part of a ContentPart[] attachment payload, not the serialized blob", () => {
    const t = createThread("agent-embed");
    const stored = JSON.stringify([
      { type: "text", text: "what is in this screenshot of the dashboard" },
      { type: "image_ref", media_type: "image/png", name: "abc.png" },
    ]);
    addMessage(t.thread_id, "user", stored);
    const job = getDb().prepare("SELECT state, source_hash FROM message_embedding_jobs").get() as { state: string; source_hash: string };
    expect(["pending", "processing", "done"]).toContain(job.state);
    expect(job.source_hash).toBe(createHash("sha256").update("what is in this screenshot of the dashboard").digest("hex"));
    // The persisted row keeps the full multimodal payload — only the
    // embedding call gets the extracted text.
    const [row] = getMessages(t.thread_id);
    expect(row.content).toBe(stored);
  });

  it("marks an attachment with no transcript text as skipped", () => {
    const t = createThread("agent-embed");
    const stored = JSON.stringify([
      { type: "text", text: "" },
      { type: "image_ref", media_type: "image/png", name: "abc.png" },
    ]);
    addMessage(t.thread_id, "user", stored);
    expect(getDb().prepare("SELECT state FROM message_embedding_jobs").get()).toEqual({ state: "skipped" });
  });

  it("queues plain-string content unchanged (no attachments)", () => {
    const t = createThread("agent-embed");
    addMessage(t.thread_id, "user", "a perfectly ordinary text-only message");
    const job = getDb().prepare("SELECT source_hash, state FROM message_embedding_jobs").get() as { source_hash: string; state: string };
    expect(["pending", "processing", "done"]).toContain(job.state);
  });

  it("invalidates the old vector and schedules a new content revision", () => {
    const t = createThread("agent-embed-update");
    const message = addMessage(t.thread_id, "assistant", "original message text");
    getDb().prepare("UPDATE messages SET embedding=? WHERE msg_id=?").run("[0.1,0.2]", message.msg_id);
    const previousHash = getDb().prepare("SELECT source_hash FROM message_embedding_jobs WHERE message_id=?").get(message.msg_id) as { source_hash: string };

    updateMessageContent(message.msg_id, "revised message text");

    expect(getDb().prepare("SELECT embedding FROM messages WHERE msg_id=?").get(message.msg_id)).toEqual({ embedding: null });
    expect(getDb().prepare("SELECT source_hash FROM message_embedding_jobs WHERE message_id=?").get(message.msg_id)).not.toEqual(previousHash);
  });
});

describe("addMessage metadata", () => {
  beforeEach(() => {
    for (const t of listThreads(1000, 0)) deleteThread(t.thread_id);
  });

  it("stores null when no metadata is supplied", () => {
    const t = createThread("agent-meta");
    addMessage(t.thread_id, "assistant", "hi");
    const [row] = getMessages(t.thread_id);
    expect(row.metadata).toBeNull();
  });

  it("stores null for an empty-object metadata payload (no wasted bytes)", () => {
    const t = createThread("agent-meta");
    addMessage(t.thread_id, "assistant", "hi", undefined, null, {});
    const [row] = getMessages(t.thread_id);
    expect(row.metadata).toBeNull();
  });

  it("persists a populated metadata object as JSON", () => {
    const t = createThread("agent-meta");
    const meta = { citations: { checker_model: "haiku", claims: [], unverified_links: ["https://a"] } };
    addMessage(t.thread_id, "assistant", "claim with [src](https://a)", undefined, null, meta);
    const [row] = getMessages(t.thread_id);
    expect(row.metadata).toBe(JSON.stringify(meta));
  });

  it("assigns strictly increasing seq even when created_at collides within one clock tick", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const thread = createThread("agent-meta");
      for (let index = 0; index < 5; index += 1) {
        addMessage(thread.thread_id, index % 2 === 0 ? "user" : "assistant", `message ${index}`);
      }

      const rows = getMessages(thread.thread_id);
      // created_at is untouched wall-clock — every row legitimately shares
      // the frozen instant. Ordering no longer depends on it.
      expect(rows.every((row) => row.created_at === "2026-01-01T00:00:00.000Z")).toBe(true);
      const seqs = rows.map((row) => row.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pruneThreadMessages", () => {
  beforeEach(() => {
    for (const t of listThreads(1000, 0)) deleteThread(t.thread_id);
  });

  it("is a no-op when message count is at or below the cap", () => {
    const t = createThread("agent-prune");
    addMessage(t.thread_id, "user", "a");
    addMessage(t.thread_id, "assistant", "b");
    expect(pruneThreadMessages(t.thread_id, 10)).toBe(0);
    expect(getMessages(t.thread_id)).toHaveLength(2);
  });

  it("ignores non-positive caps (defensive)", () => {
    const t = createThread("agent-prune");
    addMessage(t.thread_id, "user", "a");
    expect(pruneThreadMessages(t.thread_id, 0)).toBe(0);
    expect(pruneThreadMessages(t.thread_id, -5)).toBe(0);
    expect(getMessages(t.thread_id)).toHaveLength(1);
  });

  it("keeps the most recent N and deletes the older overflow", () => {
    const t = createThread("agent-prune");
    for (let i = 0; i < 6; i++) addMessage(t.thread_id, i % 2 === 0 ? "user" : "assistant", `m${i}`);
    const removed = pruneThreadMessages(t.thread_id, 4);
    expect(removed).toBe(2);
    const rows = getMessages(t.thread_id);
    expect(rows).toHaveLength(4);
    // Oldest two (m0, m1) gone; remaining are m2..m5 in order.
    expect(rows.map((r) => r.content)).toEqual(["m2", "m3", "m4", "m5"]);
    // message_count column tracks the live row count after pruning.
    expect(getThread(t.thread_id)?.message_count).toBe(4);
  });

  it("preserveFromSeq deletes only rows strictly before that seq cursor", () => {
    const t = createThread("agent-prune");
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(addMessage(t.thread_id, "user", `m${i}`));
    // keepLast is irrelevant on this branch — the seq cursor is authoritative.
    const removed = pruneThreadMessages(t.thread_id, 1, rows[3].seq);
    expect(removed).toBe(3);
    expect(getMessages(t.thread_id).map((r) => r.content)).toEqual(["m3", "m4"]);
  });

  it("preserveFromSeq is a same-millisecond collision safe: a tied created_at at the cursor doesn't get skipped", () => {
    // Regression for the boundary tie that reappeared once addMessage
    // stopped bumping colliding created_at values (ADR-0088). The seq
    // cursor disambiguates a burst even when every created_at is identical.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    try {
      const t = createThread("agent-prune-collide");
      const rows = [];
      for (let i = 0; i < 4; i++) rows.push(addMessage(t.thread_id, "user", `m${i}`));
      expect(new Set(rows.map((r) => r.created_at)).size).toBe(1);

      const removed = pruneThreadMessages(t.thread_id, 1, rows[2].seq);
      expect(removed).toBe(2);
      expect(getMessages(t.thread_id).map((r) => r.content)).toEqual(["m2", "m3"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserveFromSeq never deletes scheduled_task/watcher/bridge rows — the warm summary that authorizes this prune never covers them (getRecentMessagesWindow's 'foreground' scope excludes those categories)", () => {
    const t = createThread("agent-prune-automation");
    addMessage(t.thread_id, "user", "chat before 1"); // foreground, before cursor — safe to prune
    addMessage(t.thread_id, "user", "chat before 2"); // foreground, before cursor — safe to prune
    addMessage(t.thread_id, "assistant", "scheduled task ran", null, "scheduled_task");
    addMessage(t.thread_id, "assistant", "watcher fired", null, "watcher");
    addMessage(t.thread_id, "assistant", "bridge inbound", null, "bridge");
    const cursor = addMessage(t.thread_id, "user", "chat after"); // the compaction boundary row

    const removed = pruneThreadMessages(t.thread_id, 1, cursor.seq);

    expect(removed).toBe(2); // only the two foreground "chat before" rows
    const remaining = getMessages(t.thread_id).map((r) => r.content);
    expect(remaining).toEqual(["scheduled task ran", "watcher fired", "bridge inbound", "chat after"]);
  });

  it("drift guard: every category getRecentMessagesWindow's foreground scope excludes is also guarded by pruneThreadMessages, for the full FOREGROUND_EXCLUDED_CATEGORIES list", () => {
    // Both call sites build their SQL from the same exported constant
    // (see threads.ts) — this test exercises every entry in that list, not
    // just the three hand-picked in the test above, so adding a category to
    // the constant without wiring it into both places would fail here.
    expect(FOREGROUND_EXCLUDED_CATEGORIES.length).toBeGreaterThan(0);
    for (const category of FOREGROUND_EXCLUDED_CATEGORIES) {
      const t = createThread(`agent-drift-${category}`);
      addMessage(t.thread_id, "user", "foreground row 1");
      addMessage(t.thread_id, "user", "foreground row 2");
      addMessage(t.thread_id, "assistant", `${category} row`, null, category);
      const cursor = addMessage(t.thread_id, "user", "chat after");

      const foreground = getRecentMessagesWindow(t.thread_id, 0, undefined, "foreground");
      expect(foreground.map((r) => r.content)).not.toContain(`${category} row`);

      // preserveFromSeq deletes every guarded row before the cursor, keepLast
      // is irrelevant on this branch (see the test above) — with the guard
      // correctly excluding the category row, that's both "foreground row"s.
      const removed = pruneThreadMessages(t.thread_id, 1, cursor.seq);
      expect(removed).toBe(2); // both foreground rows — the category row must survive
      expect(getMessages(t.thread_id).map((r) => r.content)).toContain(`${category} row`);
    }
  });

  it("archives pruned chat messages to memory_store under chat_archive namespace", () => {
    const t = createThread("agent-archive");
    for (let i = 0; i < 6; i++) addMessage(t.thread_id, i % 2 === 0 ? "user" : "assistant", `m${i}`);
    // addMessage's async embedding path isn't configured in this test
    // environment, so simulate the end state (embeddings landed) via a
    // direct UPDATE. The oldest two (m0, m1) are about to be pruned —
    // those are the ones we assert archival for.
    const db = getDb();
    const fakeVec = JSON.stringify(new Array(8).fill(0.1));
    db.prepare("UPDATE messages SET embedding=? WHERE thread_id=?").run(fakeVec, t.thread_id);

    const removed = pruneThreadMessages(t.thread_id, 4);
    expect(removed).toBe(2);

    const archived = db.prepare(
      "SELECT namespace, key, value, embedding FROM memory_store WHERE namespace='chat_archive' AND key LIKE ?",
    ).all(`%::${t.thread_id}::%`) as Array<{ namespace: string; key: string; value: string; embedding: string }>;
    expect(archived).toHaveLength(2);
    // Keys encode role::thread_id::msg_id so recall() can parse the role
    // and thread_id back and emit a message-source hit.
    expect(archived[0].key.split("::")[0]).toMatch(/^(user|assistant)$/);
    expect(archived[0].key.split("::")[1]).toBe(t.thread_id);
    expect(archived.map((r) => r.value).sort()).toEqual(["m0", "m1"]);
    // The embedding is copied over verbatim so recall() can use it
    // without a fresh round-trip to the embedding provider.
    expect(archived[0].embedding).toBe(fakeVec);
  });

  it("skips archiving non-chat roles and messages without an embedding", () => {
    const t = createThread("agent-archive-skip");
    for (let i = 0; i < 6; i++) addMessage(t.thread_id, "user", `nope-${i}`);
    const db = getDb();
    // Only the oldest row gets an embedding; the next one should be
    // skipped silently (we still delete it from messages).
    const victim = db.prepare(
      "SELECT msg_id FROM messages WHERE thread_id=? ORDER BY rowid ASC LIMIT 1",
    ).get(t.thread_id) as { msg_id: string };
    const fakeVec = JSON.stringify(new Array(8).fill(0.2));
    db.prepare("UPDATE messages SET embedding=? WHERE msg_id=?").run(fakeVec, victim.msg_id);

    const removed = pruneThreadMessages(t.thread_id, 4);
    expect(removed).toBe(2);
    const archived = db.prepare(
      "SELECT value FROM memory_store WHERE namespace='chat_archive' AND key LIKE ?",
    ).all(`%::${t.thread_id}::%`) as Array<{ value: string }>;
    // Exactly one archived — the row that had an embedding.
    expect(archived).toHaveLength(1);
    expect(archived[0].value).toBe("nope-0");
  });
});

describe("pagination cursors are seq-based, not timestamp-based", () => {
  beforeEach(() => {
    for (const t of listThreads(1000, 0)) deleteThread(t.thread_id);
  });

  it("getMessagesPage orders by seq and paginates via a beforeSeq cursor", () => {
    const t = createThread("agent-page");
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(addMessage(t.thread_id, "user", `m${i}`));

    const first = getMessagesPage(t.thread_id, 2);
    expect(first.messages.map((m) => m.content)).toEqual(["m3", "m4"]);
    expect(first.has_more).toBe(true);

    const oldestSeqOnPage = first.messages[0].seq;
    const second = getMessagesPage(t.thread_id, 2, oldestSeqOnPage);
    expect(second.messages.map((m) => m.content)).toEqual(["m1", "m2"]);
    expect(second.has_more).toBe(true);
  });

  it("getMessagesAfter returns only rows with a strictly greater seq", () => {
    const t = createThread("agent-page");
    const rows = [];
    for (let i = 0; i < 4; i++) rows.push(addMessage(t.thread_id, "user", `m${i}`));

    const after = getMessagesAfter(t.thread_id, rows[1].seq);
    expect(after.map((m) => m.content)).toEqual(["m2", "m3"]);
  });

  it("does not skip or duplicate rows when created_at collides across the whole burst", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
    try {
      const t = createThread("agent-page-collide");
      const rows = [];
      for (let i = 0; i < 6; i++) rows.push(addMessage(t.thread_id, "user", `m${i}`));
      expect(new Set(rows.map((r) => r.created_at)).size).toBe(1);

      const page = getMessagesPage(t.thread_id, 3);
      expect(page.messages.map((m) => m.content)).toEqual(["m3", "m4", "m5"]);

      const after = getMessagesAfter(t.thread_id, rows[2].seq);
      expect(after.map((m) => m.content)).toEqual(["m3", "m4", "m5"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getRecentMessagesWindow (ADR-0069)", () => {
  beforeEach(() => {
    for (const t of listThreads(1000, 0)) deleteThread(t.thread_id);
  });

  it("excludes run_error marker rows from the LLM history window", () => {
    const t = createThread("agent-y");
    addMessage(t.thread_id, "user", "hi");
    addMessage(t.thread_id, "assistant", "hi back");
    addMessage(t.thread_id, "assistant", "API_KEY_INVALID", null, "run_error", { code: "auth_failed" });
    addMessage(t.thread_id, "user", "again");
    // getMessages sees all four rows; getRecentMessagesWindow strips run_error.
    expect(getMessages(t.thread_id)).toHaveLength(4);
    const window = getRecentMessagesWindow(t.thread_id, 100);
    expect(window.map((m) => m.content)).toEqual(["hi", "hi back", "again"]);
  });
});

describe("scope='channels' (ADR-0044)", () => {
  beforeEach(() => {
    for (const t of listThreads(1000, 0)) deleteThread(t.thread_id);
  });

  it("with only 'chat' active, returns exactly what 'foreground' scope excluded categories would — category IS NULL rows", () => {
    const t = createThread("agent-channels-1");
    addMessage(t.thread_id, "user", "chat row");
    addMessage(t.thread_id, "assistant", "scheduled task ran", null, "scheduled_task");
    const window = getRecentMessagesWindow(t.thread_id, 0, undefined, "channels", undefined, ["chat"]);
    expect(window.map((m) => m.content)).toEqual(["chat row"]);
  });

  it("with chat + one automation channel active, returns rows from both and excludes the third", () => {
    const t = createThread("agent-channels-2");
    addMessage(t.thread_id, "user", "chat row");
    addMessage(t.thread_id, "assistant", "scheduled task ran", null, "scheduled_task");
    addMessage(t.thread_id, "assistant", "watcher fired", null, "watcher");
    const window = getRecentMessagesWindow(t.thread_id, 0, undefined, "channels", undefined, ["chat", "scheduled_task"]);
    expect(window.map((m) => m.content)).toEqual(["chat row", "scheduled task ran"]);
  });

  it("with an empty or omitted channel list, returns nothing rather than falling back to 'all'", () => {
    const t = createThread("agent-channels-3");
    addMessage(t.thread_id, "user", "chat row");
    expect(getRecentMessagesWindow(t.thread_id, 0, undefined, "channels", undefined, [])).toEqual([]);
    expect(getRecentMessagesWindow(t.thread_id, 0, undefined, "channels")).toEqual([]);
  });
});

describe("getMessagesByAutomationCategory (ADR-0044)", () => {
  beforeEach(() => {
    for (const t of listThreads(1000, 0)) deleteThread(t.thread_id);
  });

  it("returns only rows in that exact category, chronological order", () => {
    const t = createThread("agent-automation-cat");
    addMessage(t.thread_id, "user", "chat row");
    addMessage(t.thread_id, "assistant", "watcher one", null, "watcher");
    addMessage(t.thread_id, "assistant", "bridge row", null, "bridge");
    addMessage(t.thread_id, "assistant", "watcher two", null, "watcher");
    expect(getMessagesByAutomationCategory(t.thread_id, "watcher").map((m) => m.content))
      .toEqual(["watcher one", "watcher two"]);
  });

  it("rejects a category outside FOREGROUND_EXCLUDED_CATEGORIES", () => {
    const t = createThread("agent-automation-cat-2");
    expect(() => getMessagesByAutomationCategory(t.thread_id, "chat")).toThrow();
    expect(() => getMessagesByAutomationCategory(t.thread_id, "synthetic")).toThrow();
  });
});

describe("thread channel summaries (ADR-0044)", () => {
  beforeEach(() => {
    for (const t of listThreads(1000, 0)) deleteThread(t.thread_id);
  });

  it("returns null before any commit, then the committed row after", () => {
    const t = createThread("agent-chsum-1");
    expect(getThreadChannelSummary(t.thread_id, "watcher")).toBeNull();

    commitThreadChannelSummary(t.thread_id, "watcher", { summary: "recap", summaryBefore: "2026-01-01T00:00:00.000Z", summaryBeforeSeq: 1 });
    const row = getThreadChannelSummary(t.thread_id, "watcher");
    expect(row?.summary).toBe("recap");
    expect(row?.summary_before).toBe("2026-01-01T00:00:00.000Z");
    expect(row?.computed_at).toBeTruthy();
  });

  it("upserts in place — a second commit for the same channel replaces, not duplicates", () => {
    const t = createThread("agent-chsum-2");
    commitThreadChannelSummary(t.thread_id, "bridge", { summary: "first", summaryBefore: "2026-01-01T00:00:00.000Z", summaryBeforeSeq: 1 });
    commitThreadChannelSummary(t.thread_id, "bridge", { summary: "second", summaryBefore: "2026-01-02T00:00:00.000Z", summaryBeforeSeq: 2 });
    expect(getThreadChannelSummary(t.thread_id, "bridge")?.summary).toBe("second");
  });

  it("keeps separate rows per channel on the same thread", () => {
    const t = createThread("agent-chsum-3");
    commitThreadChannelSummary(t.thread_id, "watcher", { summary: "watcher recap", summaryBefore: null });
    commitThreadChannelSummary(t.thread_id, "bridge", { summary: "bridge recap", summaryBefore: null });
    expect(getThreadChannelSummary(t.thread_id, "watcher")?.summary).toBe("watcher recap");
    expect(getThreadChannelSummary(t.thread_id, "bridge")?.summary).toBe("bridge recap");
  });
});

describe("getRecentlyUsedToolNames", () => {
  it("returns called tools most recent first, resolving invoke_tool targets", () => {
    const t = createThread("agent-recent-tools");
    addMessage(t.thread_id, "assistant", "older", [
      { id: "1", phase: "call", name: "gmail_search", payload: {} },
      { id: "1", phase: "result", name: "gmail_search", payload: {} },
    ]);
    addMessage(t.thread_id, "assistant", "newer", [
      { id: "2", phase: "call", name: "invoke_tool", payload: { name: "outlook_search", args_json: "{}" } },
      { id: "3", phase: "call", name: "memory_read", payload: {} },
    ]);

    expect(getRecentlyUsedToolNames(t.thread_id)).toEqual(["memory_read", "outlook_search", "gmail_search"]);
  });

  it("ignores malformed tool events", () => {
    const t = createThread("agent-recent-tools-bad");
    getDb().prepare("INSERT INTO messages (msg_id,thread_id,role,content,created_at,tool_events) VALUES (?,?,?,?,?,?)")
      .run("bad-1", t.thread_id, "assistant", "x", new Date().toISOString(), "not json");
    expect(getRecentlyUsedToolNames(t.thread_id)).toEqual([]);
  });
});