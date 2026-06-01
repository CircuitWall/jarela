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
const { registerScript } = await import("@/lib/triggers/scripts");
const { subscribe } = await import("@/lib/notifications/bus");
// ADR-0031 — register a fake `reaction.*` script so kind='script' watchers
// can be persisted in this test file without depending on the side-effect
// import of lib/triggers/reactions/notify.ts.
registerScript("reaction.test", async () => ({ preview: "test" }));

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
    registerTools("Schedule", "read", [fakeTool]);
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
    expect(fired.prompt).toContain("--- Diff (previous -> current) ---");
    expect(fired.prompt).toContain("- v1");
    expect(fired.prompt).toContain("+ v2");
    expect(fired.prompt).not.toContain("--- Previous result ---");
    expect(fired.prompt).not.toContain("--- Current result ---");
    const after = getWatcher(w.id)!;
    expect(after.last_fired_at).not.toBeNull();
  });

  it("truncates oversized result payloads in the firing prompt", async () => {
    const w = createWatcher({
      agent_id: "a", label: "big", tool_name: "watcher_test_tool", interval_seconds: 60,
    });
    fakeResult = "A".repeat(5000);
    await watcherHandler.getDueFirings(new Date(Date.parse(w.next_run_at) + 1));
    fakeResult = "B".repeat(5000);
    const w2 = getWatcher(w.id)!;
    const firings = await watcherHandler.getDueFirings(new Date(Date.parse(w2.next_run_at) + 1));
    expect(firings).toHaveLength(1);
    const fired = firings[0];
    if (fired.mode !== "prompt") throw new Error("expected prompt firing");
    expect(fired.prompt).toContain("[diff truncated: showing");
    expect(fired.prompt.length).toBeLessThan(8000);
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

  // ADR-0030 — the firing prompt's trailing directive comes from
  // `reaction_prompt` when set; otherwise it falls back to the default.
  it("substitutes reaction_prompt for the default directive when set", async () => {
    const w = createWatcher({
      agent_id: "a", label: "react", tool_name: "watcher_test_tool", interval_seconds: 60,
      reaction_prompt: "Open a Jira ticket against the broken dashboard.",
    });
    await watcherHandler.getDueFirings(new Date(Date.parse(w.next_run_at) + 1));
    fakeResult = "v2";
    const w2 = getWatcher(w.id)!;
    const firings = await watcherHandler.getDueFirings(new Date(Date.parse(w2.next_run_at) + 1));
    expect(firings).toHaveLength(1);
    const fired = firings[0];
    if (fired.mode !== "prompt") throw new Error("expected prompt firing");
    expect(fired.prompt).toContain("Open a Jira ticket against the broken dashboard.");
    expect(fired.prompt).not.toContain("Summarise what changed");
    // Diff envelope is preserved.
    expect(fired.prompt).toContain("- v1");
    expect(fired.prompt).toContain("+ v2");
  });

  it("uses the default directive when reaction_prompt is null", async () => {
    const w = createWatcher({
      agent_id: "a", label: "default-react", tool_name: "watcher_test_tool", interval_seconds: 60,
    });
    await watcherHandler.getDueFirings(new Date(Date.parse(w.next_run_at) + 1));
    fakeResult = "v2";
    const w2 = getWatcher(w.id)!;
    const firings = await watcherHandler.getDueFirings(new Date(Date.parse(w2.next_run_at) + 1));
    expect(firings).toHaveLength(1);
    const fired = firings[0];
    if (fired.mode !== "prompt") throw new Error("expected prompt firing");
    expect(fired.prompt).toContain("Summarise what changed");
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

  // ADR-0031 — a watcher with reaction_kind='script' emits a ScriptFiring
  // (no agent prompt) carrying the diff context plus user args.
  describe("script reactions (ADR-0031)", () => {
    it("emits a ScriptFiring with merged user args + diff context on change", async () => {
      const w = createWatcher({
        agent_id: "a", label: "scripted", tool_name: "watcher_test_tool", interval_seconds: 60,
        reaction_kind: "script",
        reaction_script: "reaction.test",
        reaction_script_args: { title: "ABC-123 changed", level: "warning" },
      });
      // Seed
      await watcherHandler.getDueFirings(new Date(Date.parse(w.next_run_at) + 1));
      fakeResult = "v2";
      const w2 = getWatcher(w.id)!;
      const firings = await watcherHandler.getDueFirings(new Date(Date.parse(w2.next_run_at) + 1));
      expect(firings).toHaveLength(1);
      const fired = firings[0];
      if (fired.mode !== "script") throw new Error("expected script firing");
      expect(fired.script).toBe("reaction.test");
      const args = fired.args!;
      // User-supplied args survive.
      expect(args).toMatchObject({ title: "ABC-123 changed", level: "warning" });
      // Diff context was injected.
      expect(args.previous).toBe("v1");
      expect(args.current).toBe("v2");
      const watcherDescriptor = args.watcher as Record<string, unknown>;
      expect(watcherDescriptor.id).toBe(w.id);
      expect(watcherDescriptor.label).toBe("scripted");
      expect(watcherDescriptor.tool_name).toBe("watcher_test_tool");
      expect(watcherDescriptor.agent_id).toBe("a");
      // Meta carries reaction_kind + script name for markFired/notification.
      expect(fired.meta?.reaction_kind).toBe("script");
      expect(fired.meta?.reaction_script).toBe("reaction.test");
    });

    it("does not fire on the first poll (baseline) even for script kind", async () => {
      const w = createWatcher({
        agent_id: "a", label: "scripted-first", tool_name: "watcher_test_tool", interval_seconds: 60,
        reaction_kind: "script",
        reaction_script: "reaction.test",
      });
      const firings = await watcherHandler.getDueFirings(new Date(Date.parse(w.next_run_at) + 1));
      expect(firings).toHaveLength(0);
    });
  });

  // Silent watchers: markFired must skip the task_completed notification on
  // success, but still publish on error so failures aren't hidden.
  describe("silent suppression", () => {
    async function firingForChange(opts: { silent: boolean; scriptMode: boolean }) {
      const w = createWatcher({
        agent_id: "a",
        label: "muted",
        tool_name: "watcher_test_tool",
        interval_seconds: 60,
        silent: opts.silent,
        ...(opts.scriptMode
          ? { reaction_kind: "script" as const, reaction_script: "reaction.test" }
          : {}),
      });
      await watcherHandler.getDueFirings(new Date(Date.parse(w.next_run_at) + 1));
      fakeResult = "v2";
      const w2 = getWatcher(w.id)!;
      const firings = await watcherHandler.getDueFirings(new Date(Date.parse(w2.next_run_at) + 1));
      return firings[0]!;
    }

    it("suppresses task_completed for silent prompt firings on success", async () => {
      const fired = await firingForChange({ silent: true, scriptMode: false });
      const events: unknown[] = [];
      const unsub = subscribe((e) => { events.push(e); });
      try {
        watcherHandler.markFired(fired, { status: "done", preview: "ok", threadId: "th" });
      } finally { unsub(); }
      expect(events).toHaveLength(0);
    });

    it("suppresses task_completed for silent script firings on success", async () => {
      const fired = await firingForChange({ silent: true, scriptMode: true });
      expect(fired.meta?.silent).toBe(true);
      const events: unknown[] = [];
      const unsub = subscribe((e) => { events.push(e); });
      try {
        watcherHandler.markFired(fired, { status: "done", preview: "ok", threadId: "" });
      } finally { unsub(); }
      expect(events).toHaveLength(0);
    });

    it("still publishes when a silent firing produced an error", async () => {
      const fired = await firingForChange({ silent: true, scriptMode: false });
      const events: unknown[] = [];
      const unsub = subscribe((e) => { events.push(e); });
      try {
        watcherHandler.markFired(fired, { status: "error", preview: "", threadId: "", error: "boom" });
      } finally { unsub(); }
      expect(events.length).toBeGreaterThan(0);
      const last = events[events.length - 1] as Record<string, unknown>;
      expect(last.error).toBe("boom");
    });
  });
});
