import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-schedule-unhappy-"));
process.env.JARELA_DB_DIR = tmpRoot;
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

vi.mock("@/lib/scheduler", () => ({ startScheduler: vi.fn() }));
vi.mock("@/lib/triggers/scripts", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, isReactionScript: (name: string) => name === "reaction.test_ping" };
});

const { scheduleTaskTool, updateScheduledTaskTool } = await import("./schedule");
const { createScheduledTask, listScheduledTasks, deleteScheduledTask, getScheduledTask } =
  await import("@/lib/stores/scheduled-tasks");
const { createThread } = await import("@/lib/stores/threads");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");

type Out = { ok?: boolean; error?: string; id?: string };
const parse = (s: unknown) => JSON.parse(String(s)) as Out;

let threadId = "";

beforeEach(() => {
  for (const t of listScheduledTasks()) deleteScheduledTask(t.id);
  upsertAgentConfig({ id: "sched-agent", name: "Sched", identity: "s", instructions: "", tools: [] });
  threadId = createThread("sched-agent").thread_id;
});

const cfg = () => ({ configurable: { thread_id: threadId } });
const future = () => new Date(Date.now() + 3_600_000).toISOString();

describe("schedule_task unhappy paths", () => {
  it("rejects a call without agent context", async () => {
    const out = parse(await scheduleTaskTool.invoke({ prompt: "x", when_iso: future() }, {}));
    expect(out.error).toMatch(/thread_id/);
    expect(listScheduledTasks()).toHaveLength(0);
  });

  it("rejects missing and conflicting timing arguments", async () => {
    expect(parse(await scheduleTaskTool.invoke({ prompt: "x" }, cfg())).error).toMatch(/when_iso|cron/);
    expect(parse(await scheduleTaskTool.invoke({ prompt: "x", when_iso: future(), cron: "0 9 * * *" }, cfg())).error)
      .toMatch(/only one/);
    expect(listScheduledTasks()).toHaveLength(0);
  });

  it("rejects invalid timestamps, invalid cron, and past one-shots", async () => {
    expect(parse(await scheduleTaskTool.invoke({ prompt: "x", when_iso: "tomorrow 9am" }, cfg())).error)
      .toMatch(/Invalid ISO/);
    expect(parse(await scheduleTaskTool.invoke({ prompt: "x", cron: "every day" }, cfg())).error).toBeTruthy();
    expect(parse(await scheduleTaskTool.invoke({ prompt: "x", when_iso: "2020-01-01T00:00:00Z" }, cfg())).error)
      .toMatch(/in the past/);
    expect(listScheduledTasks()).toHaveLength(0);
  });

  it("rejects a whitespace-only prompt instead of scheduling an empty firing", async () => {
    const out = parse(await scheduleTaskTool.invoke({ prompt: "   \n ", when_iso: future() }, cfg()));
    expect(out.error).toMatch(/prompt/);
    expect(listScheduledTasks()).toHaveLength(0);
  });

  it("rejects script reactions without a registered script name", async () => {
    expect(parse(await scheduleTaskTool.invoke({ reaction_kind: "script", cron: "0 9 * * *" }, cfg())).error)
      .toMatch(/reaction_script/);
    expect(parse(await scheduleTaskTool.invoke(
      { reaction_kind: "script", reaction_script: "reaction.nope", cron: "0 9 * * *" },
      cfg(),
    )).error).toMatch(/not registered/);
    expect(listScheduledTasks()).toHaveLength(0);
  });

  it("schedules a valid script reaction without a prompt", async () => {
    const out = parse(await scheduleTaskTool.invoke(
      { reaction_kind: "script", reaction_script: "reaction.test_ping", cron: "0 9 * * *" },
      cfg(),
    ));
    expect(out.ok).toBe(true);
  });
});

describe("update_scheduled_task unhappy paths", () => {
  it("reports unknown ids", async () => {
    expect(parse(await updateScheduledTaskTool.invoke({ id: "missing", enabled: false }, {})).error)
      .toMatch(/not found/);
  });

  it("rejects moving a one-shot task into the past", async () => {
    const row = createScheduledTask({ agent_id: "sched-agent", prompt: "p", kind: "once", schedule: future() });
    const out = parse(await updateScheduledTaskTool.invoke(
      { id: row.id, schedule: "2020-01-01T00:00:00Z" },
      {},
    ));
    expect(out.error).toMatch(/in the past/);
    expect(getScheduledTask(row.id)?.schedule).toBe(row.schedule);
  });

  it("rejects switching kind without a matching schedule and leaves the row intact", async () => {
    const row = createScheduledTask({ agent_id: "sched-agent", prompt: "p", kind: "cron", schedule: "0 9 * * *" });
    const out = parse(await updateScheduledTaskTool.invoke({ id: row.id, kind: "once" }, {}));
    expect(out.error).toMatch(/Invalid ISO/);
    expect(getScheduledTask(row.id)).toMatchObject({ kind: "cron", schedule: "0 9 * * *" });
  });

  it("rejects a whitespace-only replacement prompt", async () => {
    const row = createScheduledTask({ agent_id: "sched-agent", prompt: "keep", kind: "cron", schedule: "0 9 * * *" });
    const out = parse(await updateScheduledTaskTool.invoke({ id: row.id, prompt: "   " }, {}));
    expect(out.error).toMatch(/prompt/);
    expect(getScheduledTask(row.id)?.prompt).toBe("keep");
  });

  it("rejects switching a script task to agent_prompt without a prompt", async () => {
    const row = createScheduledTask({
      agent_id: "sched-agent",
      kind: "cron",
      schedule: "0 9 * * *",
      reaction_kind: "script",
      reaction_script: "reaction.test_ping",
    });
    const out = parse(await updateScheduledTaskTool.invoke({ id: row.id, reaction_kind: "agent_prompt" }, {}));
    expect(out.error).toMatch(/prompt/);
    expect(getScheduledTask(row.id)?.reaction_kind).toBe("script");

    const ok = parse(await updateScheduledTaskTool.invoke(
      { id: row.id, reaction_kind: "agent_prompt", prompt: "now a prompt" },
      {},
    ));
    expect(ok.ok).toBe(true);
  });
});
