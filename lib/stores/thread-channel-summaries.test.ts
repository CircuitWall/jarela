import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-channel-summaries-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { createThread, deleteThread, listThreads } = await import("./threads");
const {
  getChannelSummary,
  setChannelSummary,
  listChannelSummaries,
  clearChannelSummary,
  clearAllChannelSummaries,
} = await import("./thread-channel-summaries");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("thread_channel_summaries store (ADR-0044)", () => {
  beforeEach(() => {
    for (const t of listThreads(1000, 0)) deleteThread(t.thread_id);
  });

  it("returns null for a (thread, channel) with no row", () => {
    const t = createThread("agent-x");
    expect(getChannelSummary(t.thread_id, "chat")).toBeNull();
  });

  it("setChannelSummary inserts then upserts on the same (thread, channel)", () => {
    const t = createThread("agent-x");
    setChannelSummary(t.thread_id, "chat", "first recap", "2026-06-01T10:00:00.000Z");
    const r1 = getChannelSummary(t.thread_id, "chat");
    expect(r1?.summary).toBe("first recap");
    expect(r1?.summary_before).toBe("2026-06-01T10:00:00.000Z");

    setChannelSummary(t.thread_id, "chat", "second recap", "2026-06-01T11:00:00.000Z");
    const r2 = getChannelSummary(t.thread_id, "chat");
    expect(r2?.summary).toBe("second recap");
    expect(r2?.summary_before).toBe("2026-06-01T11:00:00.000Z");
    expect(listChannelSummaries(t.thread_id).length).toBe(1);
  });

  it("isolates summaries per channel on the same thread", () => {
    const t = createThread("agent-x");
    setChannelSummary(t.thread_id, "chat", "chat recap", "2026-06-01T10:00:00.000Z");
    setChannelSummary(t.thread_id, "scheduled_task", "task recap", "2026-06-01T10:00:00.000Z");
    setChannelSummary(t.thread_id, "watcher", "watcher recap", "2026-06-01T10:00:00.000Z");
    const all = listChannelSummaries(t.thread_id);
    expect(all.map((r) => r.channel).sort()).toEqual(["chat", "scheduled_task", "watcher"]);
    expect(getChannelSummary(t.thread_id, "chat")?.summary).toBe("chat recap");
    expect(getChannelSummary(t.thread_id, "scheduled_task")?.summary).toBe("task recap");
  });

  it("clearChannelSummary removes only the targeted channel", () => {
    const t = createThread("agent-x");
    setChannelSummary(t.thread_id, "chat", "chat recap", null);
    setChannelSummary(t.thread_id, "scheduled_task", "task recap", null);
    clearChannelSummary(t.thread_id, "chat");
    expect(getChannelSummary(t.thread_id, "chat")).toBeNull();
    expect(getChannelSummary(t.thread_id, "scheduled_task")?.summary).toBe("task recap");
  });

  it("clearAllChannelSummaries empties the thread", () => {
    const t = createThread("agent-x");
    setChannelSummary(t.thread_id, "chat", "a", null);
    setChannelSummary(t.thread_id, "watcher", "b", null);
    clearAllChannelSummaries(t.thread_id);
    expect(listChannelSummaries(t.thread_id).length).toBe(0);
  });

  it("ON DELETE CASCADE: dropping the thread removes its channel rows", () => {
    const t = createThread("agent-x");
    setChannelSummary(t.thread_id, "chat", "a", null);
    setChannelSummary(t.thread_id, "watcher", "b", null);
    deleteThread(t.thread_id);
    // Re-create with the same id is not possible (UUID); listing rows for
    // a non-existent thread returns empty.
    expect(listChannelSummaries(t.thread_id).length).toBe(0);
  });
});
