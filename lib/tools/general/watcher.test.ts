import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-watcher-tool-"));
process.env.JARELA_DB_DIR = tmpRoot;

vi.mock("@/lib/stores/threads", () => ({
  getThread: (id: string) => (id === "thread-1" ? { thread_id: id, agent_id: "agent-1" } : null),
}));
vi.mock("@/lib/scheduler", () => ({ startScheduler: vi.fn() }));

const { registerTools, _resetRegistry } = await import("@/lib/tools/runtime/registry");
const { listWatchers, deleteWatcher } = await import("@/lib/stores/watchers");
const { scheduleWatcherTool, cancelWatcherTool, updateWatcherTool } = await import("./watcher");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const config = { configurable: { thread_id: "thread-1" } };
const sideEffects = { count: 0 };

function fakeTool(name: string) {
  return tool(async () => { sideEffects.count += 1; return "ok"; }, {
    name, description: `test ${name}`, schema: z.object({}).passthrough(),
  });
}

async function schedule(args: Record<string, unknown>, cfg: unknown = config) {
  return JSON.parse(String(await scheduleWatcherTool.invoke(
    { label: "watch", every_seconds: 60, ...args } as never,
    cfg as never,
  )));
}

describe("schedule_watcher as used by an agent", () => {
  beforeEach(() => {
    _resetRegistry();
    registerTools("Files", "read", [fakeTool("watch_read")]);
    registerTools("Files", "write", [fakeTool("watch_write")]);
    registerTools("Terminal", "execute", [fakeTool("watch_exec")]);
    for (const w of listWatchers()) deleteWatcher(w.id);
    sideEffects.count = 0;
  });

  it("registers a watcher over a read-only built-in tool", async () => {
    const result = await schedule({ tool: "watch_read", args: { path: "~/Downloads" } });
    expect(result).toMatchObject({ ok: true, interval_seconds: 60 });
    expect(listWatchers()).toHaveLength(1);
    expect(sideEffects.count).toBe(0);
  });

  it.each(["watch_write", "watch_exec"])("refuses to poll side-effecting tool %s", async (name) => {
    const result = await schedule({ tool: name });
    expect(result.ok).toBeUndefined();
    expect(result.error).toMatch(/read-only/);
    expect(listWatchers()).toHaveLength(0);
    expect(sideEffects.count).toBe(0);
  });

  it("explains unknown tools without creating a watcher", async () => {
    const result = await schedule({ tool: "mcp_remote_thing" });
    expect(result.error).toMatch(/not a built-in tool/);
    expect(listWatchers()).toHaveLength(0);
  });

  it("requires agent context", async () => {
    expect((await schedule({ tool: "watch_read" }, {})).error).toMatch(/No agent context/);
    expect((await schedule({ tool: "watch_read" }, { configurable: { thread_id: "missing" } })).error)
      .toMatch(/No agent context/);
    expect(listWatchers()).toHaveLength(0);
  });

  it("rejects intervals under the 60 second minimum at the schema boundary", async () => {
    await expect(schedule({ tool: "watch_read", every_seconds: 59 })).rejects.toThrow();
    expect(listWatchers()).toHaveLength(0);
  });

  it("reports store validation failures instead of success", async () => {
    const result = await schedule({ tool: "watch_read", reaction_kind: "script", reaction_script: "not.registered" });
    expect(result.ok).toBeUndefined();
    expect(typeof result.error).toBe("string");
    expect(listWatchers()).toHaveLength(0);
  });
});

describe("update_watcher and cancel_watcher unhappy paths", () => {
  it("reports unknown ids without claiming success", async () => {
    expect(JSON.parse(String(await cancelWatcherTool.invoke({ id: "nope" })))).toEqual({ error: "Watcher nope not found" });
    expect(JSON.parse(String(await updateWatcherTool.invoke({ id: "nope", enabled: false })))).toEqual({ error: "Watcher nope not found" });
  });

  it("cancels once and reports the second cancel as not found", async () => {
    _resetRegistry();
    registerTools("Files", "read", [fakeTool("watch_read")]);
    const { id } = await schedule({ tool: "watch_read" });
    expect(JSON.parse(String(await cancelWatcherTool.invoke({ id })))).toEqual({ ok: true, id });
    expect(JSON.parse(String(await cancelWatcherTool.invoke({ id }))).error).toMatch(/not found/);
  });
});
