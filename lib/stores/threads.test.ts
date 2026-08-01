import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-threads-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  addMessage,
  createThread,
  listThreadsByAgent,
  getMessages,
  getThread,
  setThreadContextPin,
  setThreadWarmSummary,
  pruneThreadMessages,
  deleteThread,
  listThreads,
  getRecentMessagesWindow,
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
    setThreadContextPin(t.thread_id, "2026-06-01T10:00:00.000Z");
    expect(getThread(t.thread_id)?.hot_since).toBe("2026-06-01T10:00:00.000Z");
    setThreadContextPin(t.thread_id, null);
    expect(getThread(t.thread_id)?.hot_since).toBeNull();
  });

  it("setThreadWarmSummary stores text + boundary + a computed_at stamp", () => {
    const t = createThread("agent-x");
    setThreadWarmSummary(t.thread_id, "older context recap", "2026-06-01T10:00:00.000Z");
    const after = getThread(t.thread_id);
    expect(after?.warm_summary).toBe("older context recap");
    expect(after?.warm_summary_before).toBe("2026-06-01T10:00:00.000Z");
    // Stamp is wall-clock so we only assert it's a non-empty ISO-ish string.
    expect(typeof after?.warm_summary_computed_at).toBe("string");
    expect((after?.warm_summary_computed_at ?? "").length).toBeGreaterThan(10);
  });

  it("warm summary freshness key: cleared when hot_since changes (caller's responsibility — store just stores)", () => {
    // The store doesn't auto-invalidate; the convention is that the consumer
    // (buildHistoryWindow) compares warm_summary_before vs hot_since and
    // overwrites both atomically when they diverge. Verify both fields move
    // independently so the consumer can implement that contract.
    const t = createThread("agent-x");
    setThreadWarmSummary(t.thread_id, "old recap", "2026-06-01T10:00:00.000Z");
    setThreadContextPin(t.thread_id, "2026-06-01T08:00:00.000Z");
    const drifted = getThread(t.thread_id);
    expect(drifted?.hot_since).toBe("2026-06-01T08:00:00.000Z");
    expect(drifted?.warm_summary_before).toBe("2026-06-01T10:00:00.000Z");
    // ⇒ freshness check `warm_summary_before === hot_since` returns false.
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

