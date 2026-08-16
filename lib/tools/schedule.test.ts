import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated SQLite per test process. Set BEFORE importing anything that
// touches the store (mirrors propose.test.ts + scheduled-tasks.test.ts).
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-schedule-tool-"));
process.env.JARELA_DB_DIR = tmpRoot;
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { listScheduledTasksTool, updateScheduledTaskTool } = await import("./schedule");
const {
  createScheduledTask,
  listScheduledTasks,
  deleteScheduledTask,
  getScheduledTask,
} = await import("@/lib/stores/scheduled-tasks");
const { scheduleWatcherTool, updateWatcherTool } = await import("./watcher");
const { deleteWatcher, getWatcher, listWatchers } = await import("@/lib/stores/watchers");
const { createThread } = await import("@/lib/stores/threads");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");

function parse(s: unknown) {
  return JSON.parse(String(s)) as {
    tasks: Array<{
      id: string;
      agent_id: string;
      agent_name: string | null;
      owned_by_caller: boolean;
    }>;
    count: number;
  };
}

describe("list_scheduled_tasks tool (cross-agent visibility)", () => {
  beforeEach(() => {
    for (const t of listScheduledTasks()) deleteScheduledTask(t.id);
    for (const w of listWatchers()) deleteWatcher(w.id);
  });

  it("returns tasks owned by other agents and tags them with agent_id / agent_name / owned_by_caller=false", async () => {
    // Two agents: a "Default" agent (the caller) and a "Bridge Listener"
    // that would own bridge-scheduled tasks in real installations.
    upsertAgentConfig({
      id: "default-agent",
      name: "Default",
      identity: "d",
      instructions: "",
      tools: [],
      model_config_name: null,
      is_default: true,
    });
    upsertAgentConfig({
      id: "bridge-listener",
      name: "Bridge Listener",
      identity: "b",
      instructions: "",
      tools: [],
    });

    createScheduledTask({
      agent_id: "bridge-listener",
      prompt: "check whatsapp inbox",
      kind: "cron",
      schedule: "*/5 * * * *",
    });
    createScheduledTask({
      agent_id: "default-agent",
      prompt: "morning digest",
      kind: "cron",
      schedule: "0 9 * * *",
    });

    // Invoke the tool from the Default agent's thread.
    const thread = createThread("default-agent");
    const out = parse(await listScheduledTasksTool.invoke(
      {},
      { configurable: { thread_id: thread.thread_id } },
    ));

    expect(out.count).toBe(2);
    const byAgent = Object.fromEntries(out.tasks.map((t) => [t.agent_id, t]));
    expect(byAgent["bridge-listener"]).toMatchObject({
      agent_name: "Bridge Listener",
      owned_by_caller: false,
    });
    expect(byAgent["default-agent"]).toMatchObject({
      agent_name: "Default",
      owned_by_caller: true,
    });
  });

  it("still returns rows when called without a thread_id (owned_by_caller=false for everything)", async () => {
    upsertAgentConfig({
      id: "orphan-owner",
      name: "Orphan",
      identity: "o",
      instructions: "",
      tools: [],
    });
    createScheduledTask({
      agent_id: "orphan-owner",
      prompt: "hi",
      kind: "cron",
      schedule: "0 * * * *",
    });

    const out = parse(await listScheduledTasksTool.invoke({}, {}));
    expect(out.count).toBe(1);
    expect(out.tasks[0].agent_name).toBe("Orphan");
    expect(out.tasks[0].owned_by_caller).toBe(false);
  });

  it("updates and pauses an existing scheduled task", async () => {
    upsertAgentConfig({
      id: "default-agent",
      name: "Default",
      identity: "d",
      instructions: "",
      tools: [],
      model_config_name: null,
      is_default: true,
    });
    const row = createScheduledTask({
      agent_id: "default-agent",
      prompt: "old prompt",
      kind: "cron",
      schedule: "0 9 * * *",
    });

    const out = JSON.parse(String(await updateScheduledTaskTool.invoke({
      id: row.id,
      prompt: "new prompt",
      description: "daily check",
      enabled: false,
      silent: true,
    }, {}))) as { ok: boolean; id: string; enabled: boolean; silent: boolean; prompt: string; description: string };

    expect(out).toMatchObject({
      ok: true,
      id: row.id,
      enabled: false,
      silent: true,
      prompt: "new prompt",
      description: "daily check",
    });
    expect(getScheduledTask(row.id)).toMatchObject({
      prompt: "new prompt",
      description: "daily check",
      enabled: 0,
      silent: 1,
    });
  });

  it("updates and pauses an existing watcher", async () => {
    upsertAgentConfig({
      id: "default-agent",
      name: "Default",
      identity: "d",
      instructions: "",
      tools: [],
      model_config_name: null,
      is_default: true,
    });
    const thread = createThread("default-agent");
    const created = JSON.parse(String(await scheduleWatcherTool.invoke({
      label: "downloads",
      tool: "list_tools",
      args: {},
      every_seconds: 120,
      silent: false,
    }, { configurable: { thread_id: thread.thread_id } }))) as { id: string };

    const out = JSON.parse(String(await updateWatcherTool.invoke({
      id: created.id,
      label: "paused downloads",
      interval_seconds: 300,
      enabled: false,
      silent: true,
      reaction_prompt: "Only notify if there is a material change.",
    }, {}))) as { ok: boolean; id: string; label: string; enabled: boolean; silent: boolean; interval_seconds: number; reaction_prompt: string };

    expect(out).toMatchObject({
      ok: true,
      id: created.id,
      label: "paused downloads",
      enabled: false,
      silent: true,
      interval_seconds: 300,
      reaction_prompt: "Only notify if there is a material change.",
    });
    expect(getWatcher(created.id)).toMatchObject({
      label: "paused downloads",
      enabled: 0,
      silent: 1,
      interval_seconds: 300,
      reaction_prompt: "Only notify if there is a material change.",
    });
  });
});
