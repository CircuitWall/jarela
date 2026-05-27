import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-scheduled-tasks-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  createScheduledTask,
  listScheduledTasks,
  getScheduledTask,
  deleteScheduledTask,
  updateScheduledTask,
} = await import("./scheduled-tasks");

const { registerScript } = await import("@/lib/triggers/scripts");
registerScript("reaction.test", async () => ({ preview: "test" }));

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("scheduled-tasks store (ADR-0032)", () => {
  beforeEach(() => {
    for (const t of listScheduledTasks()) deleteScheduledTask(t.id);
  });

  it("defaults to reaction_kind='agent_prompt' with both script columns null", () => {
    const t = createScheduledTask({
      agent_id: "a",
      prompt: "hello",
      kind: "cron",
      schedule: "0 * * * *",
    });
    expect(t.reaction_kind).toBe("agent_prompt");
    expect(t.reaction_script).toBeNull();
    expect(t.reaction_script_args).toBeNull();
  });

  it("creates a script-kind task with empty prompt sentinel", () => {
    const t = createScheduledTask({
      agent_id: "a",
      kind: "cron",
      schedule: "0 * * * *",
      reaction_kind: "script",
      reaction_script: "reaction.test",
      reaction_script_args: { title: "tick" },
    });
    expect(t.reaction_kind).toBe("script");
    expect(t.reaction_script).toBe("reaction.test");
    expect(t.reaction_script_args).toBe(JSON.stringify({ title: "tick" }));
    expect(t.prompt).toBe("");
  });

  it("requires prompt for kind='agent_prompt'", () => {
    expect(() => createScheduledTask({
      agent_id: "a",
      kind: "cron",
      schedule: "0 * * * *",
    })).toThrow(/prompt is required/);
  });

  it("rejects reaction_kind='script' without reaction_script", () => {
    expect(() => createScheduledTask({
      agent_id: "a",
      kind: "cron",
      schedule: "0 * * * *",
      reaction_kind: "script",
    })).toThrow(/requires reaction_script/);
  });

  it("rejects an unregistered reaction_script", () => {
    expect(() => createScheduledTask({
      agent_id: "a",
      kind: "cron",
      schedule: "0 * * * *",
      reaction_kind: "script",
      reaction_script: "reaction.nonexistent",
    })).toThrow(/not registered/);
  });

  it("rejects a reaction_script that lacks the reaction. prefix", () => {
    expect(() => createScheduledTask({
      agent_id: "a",
      kind: "cron",
      schedule: "0 * * * *",
      reaction_kind: "script",
      reaction_script: "documents.reindex_local_file",
    })).toThrow(/must begin with "reaction\."/);
  });

  it("updateScheduledTask: switching kind to 'script' clears the prompt-side fields and sets script columns", () => {
    const t = createScheduledTask({
      agent_id: "a",
      prompt: "old",
      kind: "cron",
      schedule: "0 * * * *",
    });
    const updated = updateScheduledTask(t.id, {
      reaction_kind: "script",
      reaction_script: "reaction.test",
      reaction_script_args: { x: 1 },
    })!;
    expect(updated.reaction_kind).toBe("script");
    expect(updated.reaction_script).toBe("reaction.test");
    expect(updated.reaction_script_args).toBe(JSON.stringify({ x: 1 }));
  });

  it("updateScheduledTask: switching kind back to 'agent_prompt' clears script columns", () => {
    const t = createScheduledTask({
      agent_id: "a",
      kind: "cron",
      schedule: "0 * * * *",
      reaction_kind: "script",
      reaction_script: "reaction.test",
      reaction_script_args: { x: 1 },
    });
    const updated = updateScheduledTask(t.id, {
      reaction_kind: "agent_prompt",
      prompt: "now an agent prompt",
    })!;
    expect(updated.reaction_kind).toBe("agent_prompt");
    expect(updated.reaction_script).toBeNull();
    expect(updated.reaction_script_args).toBeNull();
    expect(updated.prompt).toBe("now an agent prompt");
  });

  it("updateScheduledTask: kind-preserving patch can update reaction_script_args while staying in 'script' kind", () => {
    const t = createScheduledTask({
      agent_id: "a",
      kind: "cron",
      schedule: "0 * * * *",
      reaction_kind: "script",
      reaction_script: "reaction.test",
    });
    const updated = updateScheduledTask(t.id, { reaction_script_args: { y: 2 } })!;
    expect(updated.reaction_kind).toBe("script");
    expect(updated.reaction_script_args).toBe(JSON.stringify({ y: 2 }));
    // Cannot clear reaction_script while still in 'script' mode.
    expect(() => updateScheduledTask(t.id, { reaction_script: null })).toThrow(/cannot be cleared/);
  });

  it("getScheduledTask returns the persisted reaction columns", () => {
    const t = createScheduledTask({
      agent_id: "a",
      kind: "cron",
      schedule: "0 * * * *",
      reaction_kind: "script",
      reaction_script: "reaction.test",
      reaction_script_args: { hello: "world" },
    });
    const fetched = getScheduledTask(t.id)!;
    expect(fetched.reaction_kind).toBe("script");
    expect(fetched.reaction_script).toBe("reaction.test");
    expect(fetched.reaction_script_args).toBe(JSON.stringify({ hello: "world" }));
  });
});
