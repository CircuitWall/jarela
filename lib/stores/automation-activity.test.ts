import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-automation-activity-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { addMessage, createThread, getMessages } = await import("./threads");
const {
  createAutomationActivity,
  finalizeAutomationActivity,
  updateAutomationActivity,
  listAutomationActivities,
} = await import("./automation-activity");
const { getDb } = await import("@/lib/db");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("automation activity store", () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM messages").run();
    db.prepare("DELETE FROM threads").run();
  });

  it("creates and finalizes a typed activity row", () => {
    const thread = createThread("agent-a");
    const row = createAutomationActivity({
      threadId: thread.thread_id,
      sourceKind: "scheduled_task",
      sourceId: "task-1",
      label: "Email check",
      state: "queued",
      detail: "Check unread mail",
    });

    updateAutomationActivity(row.msg_id, { state: "checking" });
    const final = finalizeAutomationActivity(row.msg_id, {
      disposition: "action",
      preview: "Sent a digest",
    });

    expect(final?.content).toBe("Email check: action taken");
    const metadata = JSON.parse(final!.metadata!) as Record<string, {
      state: string;
      disposition: string;
      preview: string;
    }>;
    expect(metadata.automation_activity).toMatchObject({
      state: "complete",
      disposition: "action",
      preview: "Sent a digest",
    });
  });

  it("collapses consecutive no-action rows for the same source", () => {
    const thread = createThread("agent-a");
    const first = createAutomationActivity({
      threadId: thread.thread_id,
      sourceKind: "watcher",
      sourceId: "watcher-1",
      label: "Release watcher",
    });
    finalizeAutomationActivity(first.msg_id, { disposition: "no_action" });

    const second = createAutomationActivity({
      threadId: thread.thread_id,
      sourceKind: "watcher",
      sourceId: "watcher-1",
      label: "Release watcher",
    });
    const collapsed = finalizeAutomationActivity(second.msg_id, {
      disposition: "no_action",
    });

    expect(getMessages(thread.thread_id)).toHaveLength(1);
    const metadata = JSON.parse(collapsed!.metadata!) as Record<string, {
      occurrence_count: number;
      disposition: string;
    }>;
    expect(metadata.automation_activity).toMatchObject({
      occurrence_count: 2,
      disposition: "no_action",
    });
  });

  it("does not collapse across a foreground message", () => {
    const thread = createThread("agent-a");
    const first = createAutomationActivity({
      threadId: thread.thread_id,
      sourceKind: "watcher",
      sourceId: "watcher-1",
      label: "Release watcher",
    });
    finalizeAutomationActivity(first.msg_id, { disposition: "no_action" });

    addMessage(thread.thread_id, "user", "What changed?");

    const second = createAutomationActivity({
      threadId: thread.thread_id,
      sourceKind: "watcher",
      sourceId: "watcher-1",
      label: "Release watcher",
    });
    finalizeAutomationActivity(second.msg_id, { disposition: "no_action" });

    expect(getMessages(thread.thread_id)).toHaveLength(3);
  });
});

describe("listAutomationActivities", () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM messages").run();
    db.prepare("DELETE FROM threads").run();
  });

  it("filters by source, disposition, and limit and returns newest first", () => {
    const thread = createThread("agent-a");
    const failed = createAutomationActivity({
      threadId: thread.thread_id,
      sourceKind: "scheduled_task",
      sourceId: "task-1",
      label: "Task one",
    });
    finalizeAutomationActivity(failed.msg_id, {
      disposition: "failed",
      error: "stream stalled",
    });

    const action = createAutomationActivity({
      threadId: thread.thread_id,
      sourceKind: "watcher",
      sourceId: "watcher-1",
      label: "Watcher one",
    });
    finalizeAutomationActivity(action.msg_id, {
      disposition: "action",
      preview: "changed",
    });

    const bridge = createAutomationActivity({
      threadId: thread.thread_id,
      sourceKind: "bridge",
      sourceId: "bridge-1",
      label: "Bridge one",
    });
    finalizeAutomationActivity(bridge.msg_id, { disposition: "cancelled" });

    expect(listAutomationActivities()).toHaveLength(3);

    const failedOnly = listAutomationActivities({ disposition: "failed" });
    expect(failedOnly).toHaveLength(1);
    expect(failedOnly[0]?.activity).toMatchObject({
      source_id: "task-1",
      disposition: "failed",
      error: "stream stalled",
    });

    const watcherOnly = listAutomationActivities({ sourceKind: "watcher" });
    expect(watcherOnly).toHaveLength(1);
    expect(watcherOnly[0]?.activity.source_id).toBe("watcher-1");

    const bySource = listAutomationActivities({ sourceId: "bridge-1" });
    expect(bySource).toHaveLength(1);
    expect(bySource[0]?.activity.disposition).toBe("cancelled");

    const newest = listAutomationActivities({ limit: 1 });
    expect(newest).toHaveLength(1);
    expect(newest[0]?.activity.source_id).toBe("bridge-1");
  });

  it("ignores malformed activity metadata", () => {
    const thread = createThread("agent-a");
    addMessage(thread.thread_id, "assistant", "malformed", undefined, "scheduled_task", {
      automation_activity: { version: 1 },
    });
    expect(listAutomationActivities()).toEqual([]);
  });
});
