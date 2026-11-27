import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-automation-activity-tool-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { listAutomationActivityTool } = await import("./automation-activity");
const {
  createAutomationActivity,
  finalizeAutomationActivity,
} = await import("@/lib/stores/automation-activity");
const { createThread } = await import("@/lib/stores/threads");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const { getDb } = await import("@/lib/db");
const { registeredCapability, registeredCategory } = await import(
  "@/lib/tools/runtime/registry"
);

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function parse(value: unknown) {
  return JSON.parse(String(value)) as {
    activities: Array<Record<string, unknown>>;
    count: number;
    limit: number;
    error?: string;
  };
}

describe("list_automation_activity tool", () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM messages").run();
    db.prepare("DELETE FROM threads").run();
  });

  it("registers as a strict Schedule read tool", () => {
    expect(registeredCapability("list_automation_activity")).toBe("read");
    expect(registeredCategory("list_automation_activity")).toBe("Schedule");
    const definition = convertToOpenAITool(listAutomationActivityTool);
    expect(definition.function.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  });

  it("returns failed activity with its error and no prompt or preview content", async () => {
    upsertAgentConfig({
      id: "agent-a",
      name: "Agent A",
      identity: "a",
      instructions: "",
      tools: [],
    });
    const thread = createThread("agent-a");
    const failed = createAutomationActivity({
      threadId: thread.thread_id,
      sourceKind: "scheduled_task",
      sourceId: "task-1",
      label: "Email check",
      detail: "Check unread mail",
    });
    finalizeAutomationActivity(failed.msg_id, {
      disposition: "failed",
      error: "stream stalled",
      preview: "partial output",
    });

    const out = parse(
      await listAutomationActivityTool.invoke(
        { source_id: "task-1" },
        { configurable: { thread_id: thread.thread_id } },
      ),
    );

    expect(out.count).toBe(1);
    expect(out.activities[0]).toMatchObject({
      source_kind: "scheduled_task",
      source_id: "task-1",
      label: "Email check",
      disposition: "failed",
      error: "stream stalled",
      agent_id: "agent-a",
      agent_name: "Agent A",
      thread_id: thread.thread_id,
    });
    expect(out.activities[0]).not.toHaveProperty("detail");
    expect(out.activities[0]).not.toHaveProperty("preview");
  });

  it("filters by disposition and source kind, and bounds the limit", async () => {
    const thread = createThread("agent-a");
    const fixtures = [
      { sourceKind: "scheduled_task", sourceId: "task-1", disposition: "failed" },
      { sourceKind: "scheduled_task", sourceId: "task-2", disposition: "no_action" },
      { sourceKind: "watcher", sourceId: "watcher-1", disposition: "action" },
    ] as const;
    for (const fixture of fixtures) {
      const row = createAutomationActivity({
        threadId: thread.thread_id,
        sourceKind: fixture.sourceKind,
        sourceId: fixture.sourceId,
        label: fixture.sourceId,
      });
      finalizeAutomationActivity(row.msg_id, { disposition: fixture.disposition });
    }

    expect(parse(await listAutomationActivityTool.invoke({ disposition: "failed" })).count).toBe(1);
    expect(parse(await listAutomationActivityTool.invoke({ source_kind: "watcher" })).count).toBe(1);
    expect(parse(await listAutomationActivityTool.invoke({ limit: 1 })).count).toBe(1);
    expect(parse(await listAutomationActivityTool.invoke({ source_id: "missing" })).count).toBe(0);
  });
});
