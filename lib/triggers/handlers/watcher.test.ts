import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-watcher-handler-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { registerTools, _resetRegistry } = await import("@/lib/tools/registry");
const { createWatcher, listWatchers, deleteWatcher, getWatcher } = await import("@/lib/stores/watchers");
const { watcherHandler } = await import("./watcher");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// Holder so each test can swap the value the fake tool returns.
let fakeResult: unknown = "v1";
let fakeThrows: Error | null = null;

const fakeTool = tool(
  async () => {
    if (fakeThrows) throw fakeThrows;
    return fakeResult;
  },
  {
    name: "watcher_test_tool",
    description: "test-only tool that returns whatever the test sets",
    schema: z.object({}).passthrough(),
  },
);

describe("watcherHandler (ADR-0027)", () => {
  beforeEach(() => {
    _resetRegistry();
    registerTools("Schedule", [fakeTool]);
    for (const w of listWatchers()) deleteWatcher(w.id);
    fakeResult = "v1";
    fakeThrows = null;
  });

  it("first poll seeds the fingerprint and does NOT fire", async () => {
    const w = createWatcher({
      agent_id: "a", label: "first", tool_name: "watcher_test_tool", interval_seconds: 60,
    });
    const asOf = new Date(Date.parse(w.next_run_at) + 1);
    const firings = await watcherHandler.getDueFirings(asOf);
    expect(firings).toHaveLength(0);
    const after = getWatcher(w.id)!;
    expect(after.last_fingerprint).not.toBeNull();
    expect(after.last_fired_at).toBeNull();
  });

  it("emits a firing on the second poll when result changes", async () => {
    const w = createWatcher({
      agent_id: "a", label: "change", tool_name: "watcher_test_tool", interval_seconds: 60,
    });
    // Seed
    await watcherHandler.getDueFirings(new Date(Date.parse(w.next_run_at) + 1));
    // Change result + force due again
    fakeResult = "v2";
    const w2 = getWatcher(w.id)!;
    const firings = await watcherHandler.getDueFirings(new Date(Date.parse(w2.next_run_at) + 1));
    expect(firings).toHaveLength(1);
    const fired = firings[0];
    if (fired.mode !== "prompt") throw new Error("expected prompt firing");
    expect(fired.agentId).toBe("a");
    expect(fired.kind).toBe("watcher");
    expect(fired.prompt).toContain('Watcher "change" detected a change');
    expect(fired.prompt).toContain("v1");
    expect(fired.prompt).toContain("v2");
    const after = getWatcher(w.id)!;
    expect(after.last_fired_at).not.toBeNull();
  });

  it("does NOT fire when result is unchanged across polls", async () => {
    const w = createWatcher({
      agent_id: "a", label: "stable", tool_name: "watcher_test_tool", interval_seconds: 60,
    });
    await watcherHandler.getDueFirings(new Date(Date.parse(w.next_run_at) + 1));
    const w2 = getWatcher(w.id)!;
    fakeResult = "v1"; // same as before
    const firings = await watcherHandler.getDueFirings(new Date(Date.parse(w2.next_run_at) + 1));
    expect(firings).toHaveLength(0);
  });

  it("tool errors are stored as last_error and the watcher keeps going", async () => {
    const w = createWatcher({
      agent_id: "a", label: "flaky", tool_name: "watcher_test_tool", interval_seconds: 60,
    });
    fakeThrows = new Error("upstream 500");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const firings = await watcherHandler.getDueFirings(new Date(Date.parse(w.next_run_at) + 1));
    expect(firings).toHaveLength(0);
    const after = getWatcher(w.id)!;
    expect(after.last_error).toMatch(/upstream 500/);
    expect(after.enabled).toBe(1);
    errSpy.mockRestore();
  });

  it("unknown tool_name produces an error on the row, no firing", async () => {
    const w = createWatcher({
      agent_id: "a", label: "bogus", tool_name: "no_such_tool", interval_seconds: 60,
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const firings = await watcherHandler.getDueFirings(new Date(Date.parse(w.next_run_at) + 1));
    expect(firings).toHaveLength(0);
    const after = getWatcher(w.id)!;
    expect(after.last_error).toMatch(/not registered/);
    errSpy.mockRestore();
  });
});
