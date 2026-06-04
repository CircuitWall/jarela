import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-threads-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  addMessage,
  createThread,
  getMessages,
  getThread,
  setThreadContextPin,
  setThreadWarmSummary,
  deleteThread,
  listThreads,
} = await import("./threads");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("thread context pin (ADR-0042)", () => {
  beforeEach(() => {
    for (const t of listThreads(1000, 0)) deleteThread(t.thread_id);
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
