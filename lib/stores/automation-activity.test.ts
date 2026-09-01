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
