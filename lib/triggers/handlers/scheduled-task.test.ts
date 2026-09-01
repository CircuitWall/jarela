import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-scheduled-task-handler-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  createScheduledTask,
  listScheduledTasks,
  deleteScheduledTask,
  getScheduledTask,
} = await import("@/lib/stores/scheduled-tasks");
const { scheduledTaskHandler, firingForTaskId } = await import("./scheduled-task");
const { registerScript } = await import("@/lib/triggers/scripts");
const { subscribe } = await import("@/lib/notifications/bus");

registerScript("reaction.test", async () => ({ preview: "test" }));

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("scheduledTaskHandler (ADR-0032)", () => {
  beforeEach(() => {
    for (const t of listScheduledTasks()) deleteScheduledTask(t.id);
  });

  it("emits a PromptFiring for kind='agent_prompt' tasks (default)", async () => {
    const t = createScheduledTask({
      agent_id: "a",
      prompt: "do the thing",
      kind: "once",
      schedule: new Date(Date.now() - 1000).toISOString(),
    });
    const firings = await scheduledTaskHandler.getDueFirings(new Date());
    expect(firings).toHaveLength(1);
    const fired = firings[0];
    if (fired.mode !== "prompt") throw new Error("expected prompt firing");
    expect(fired.agentId).toBe("a");
    expect(fired.prompt).toBe("do the thing");
    expect(fired.id).toBe(t.id);
  });

  it("emits a ScriptFiring with task descriptor in args for kind='script'", async () => {
    const t = createScheduledTask({
      agent_id: "a",
      kind: "once",
      schedule: new Date(Date.now() - 1000).toISOString(),
      reaction_kind: "script",
      reaction_script: "reaction.test",
      reaction_script_args: { title: "tick", level: "info" },
      description: "hourly tick",
    });
    const firings = await scheduledTaskHandler.getDueFirings(new Date());
    expect(firings).toHaveLength(1);
    const fired = firings[0];
    if (fired.mode !== "script") throw new Error("expected script firing");
    expect(fired.script).toBe("reaction.test");
    const args = fired.args ?? {};
    expect(args).toMatchObject({ title: "tick", level: "info" });
    // Diff context must NOT be injected for scheduled tasks.
    expect(args.previous).toBeUndefined();
    expect(args.current).toBeUndefined();
    const descriptor = args.task as Record<string, unknown>;
    expect(descriptor.id).toBe(t.id);
    expect(descriptor.agent_id).toBe("a");
    expect(descriptor.description).toBe("hourly tick");
    expect(descriptor.schedule_kind).toBe("once");
    expect(fired.meta?.reaction_kind).toBe("script");
    expect(fired.meta?.reaction_script).toBe("reaction.test");
  });

  it("markFired advances the schedule for cron tasks regardless of mode", () => {
    const t = createScheduledTask({
      agent_id: "a",
      kind: "cron",
      schedule: "0 * * * *",
      reaction_kind: "script",
      reaction_script: "reaction.test",
    });
    const before = getScheduledTask(t.id)!;
    const firing = firingForTaskId(t.id)!;
    scheduledTaskHandler.markFired(firing, {
      status: "done",
      preview: "ok",
      threadId: "",
    });
    const after = getScheduledTask(t.id)!;
    // Cron tasks survive markFired and have an advanced next_run_at.
    expect(after).not.toBeNull();
    expect(Date.parse(after.next_run_at)).toBeGreaterThanOrEqual(Date.parse(before.next_run_at));
    expect(after.last_run_at).not.toBeNull();
  });

  it("markFired deletes one-shot tasks after firing (script mode)", () => {
    const t = createScheduledTask({
      agent_id: "a",
      kind: "once",
      schedule: new Date(Date.now() + 60_000).toISOString(),
      reaction_kind: "script",
      reaction_script: "reaction.test",
    });
    const firing = firingForTaskId(t.id)!;
    scheduledTaskHandler.markFired(firing, {
      status: "done",
      preview: "ok",
      threadId: "",
    });
    expect(getScheduledTask(t.id)).toBeNull();
  });

  it("markFired publishes a task_completed notification for script firings", async () => {
    const t = createScheduledTask({
      agent_id: "agent-9",
      kind: "cron",
      schedule: "0 * * * *",
      reaction_kind: "script",
      reaction_script: "reaction.test",
    });
    const firing = firingForTaskId(t.id)!;
    const events: unknown[] = [];
    const unsub = subscribe((evt) => { events.push(evt); });
    try {
      scheduledTaskHandler.markFired(firing, {
        status: "done",
        preview: "ok",
        threadId: "",
      });
    } finally {
      unsub();
    }
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1] as Record<string, unknown>;
    expect(last.type).toBe("task_completed");
    expect(last.task_id).toBe(t.id);
    expect(last.agent_id).toBe("agent-9");
    expect(String(last.prompt)).toContain("reaction.test");
  });

  it("firingForTaskId returns null for unknown id", () => {
    expect(firingForTaskId("nope")).toBeNull();
  });

  it("markFired publishes a silent refresh event for silent prompt firings", async () => {
    const t = createScheduledTask({
      agent_id: "a",
      prompt: "ping",
      kind: "cron",
      schedule: "0 * * * *",
      silent: true,
    });
    const firing = firingForTaskId(t.id)!;
    if (firing.mode !== "prompt") throw new Error("expected prompt firing");
    expect(firing.silent).toBe(true);
    const events: unknown[] = [];
    const unsub = subscribe((evt) => { events.push(evt); });
    try {
      scheduledTaskHandler.markFired(firing, { status: "done", preview: "ok", threadId: "th" });
    } finally { unsub(); }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "task_completed", silent: true });
  });

  it("markFired publishes a silent refresh event for silent script firings", async () => {
    const t = createScheduledTask({
      agent_id: "a",
      kind: "cron",
      schedule: "0 * * * *",
      reaction_kind: "script",
      reaction_script: "reaction.test",
      silent: true,
    });
    const firing = firingForTaskId(t.id)!;
    if (firing.mode !== "script") throw new Error("expected script firing");
    expect(firing.meta?.silent).toBe(true);
    const events: unknown[] = [];
    const unsub = subscribe((evt) => { events.push(evt); });
    try {
      scheduledTaskHandler.markFired(firing, { status: "done", preview: "ok", threadId: "" });
    } finally { unsub(); }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "task_completed", silent: true });
  });

  it("markFired still publishes for silent firings when an error occurred", async () => {
    const t = createScheduledTask({
      agent_id: "a",
      kind: "cron",
      schedule: "0 * * * *",
      reaction_kind: "script",
      reaction_script: "reaction.test",
      silent: true,
    });
    const firing = firingForTaskId(t.id)!;
    const events: unknown[] = [];
    const unsub = subscribe((evt) => { events.push(evt); });
    try {
      scheduledTaskHandler.markFired(firing, { status: "error", preview: "", threadId: "", error: "boom" });
    } finally { unsub(); }
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1] as Record<string, unknown>;
    expect(last.error).toBe("boom");
  });
});
