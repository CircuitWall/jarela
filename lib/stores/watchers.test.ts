import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-watchers-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  createWatcher,
  listWatchers,
  getWatcher,
  getDueWatchers,
  deleteWatcher,
  updateWatcher,
  recordWatcherPoll,
  recordWatcherPollError,
  clampInterval,
} = await import("./watchers");

// ADR-0031 — register a fake `reaction.*` script so validateReactionScript
// accepts it. The store test must not depend on built-in reaction scripts
// being side-effect imported.
const { registerScript } = await import("@/lib/triggers/scripts");
registerScript("reaction.test", async () => ({ preview: "test" }));

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("watchers store (ADR-0027)", () => {
  beforeEach(() => {
    for (const w of listWatchers()) deleteWatcher(w.id);
  });

  it("clampInterval enforces the 60s floor", () => {
    expect(() => clampInterval(30)).toThrow(/>= 60/);
    expect(() => clampInterval(Number.NaN)).toThrow();
    expect(clampInterval(60)).toBe(60);
    expect(clampInterval(125.7)).toBe(125);
  });

  it("createWatcher persists args + schedules next_run_at in the future", () => {
    const w = createWatcher({
      agent_id: "agent-1",
      label: "ABC-123 status",
      tool_name: "jira_get_issue",
      tool_args: { key: "ABC-123" },
      interval_seconds: 120,
    });
    expect(w.tool_args).toBe(JSON.stringify({ key: "ABC-123" }));
    expect(new Date(w.next_run_at).getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(w.enabled).toBe(1);
    expect(w.last_fingerprint).toBeNull();
  });

  it("createWatcher rejects sub-60s intervals", () => {
    expect(() => createWatcher({
      agent_id: "a", label: "x", tool_name: "t", interval_seconds: 10,
    })).toThrow(/>= 60/);
  });

  it("getDueWatchers returns rows whose next_run_at <= asOf and ignores disabled rows", () => {
    const a = createWatcher({ agent_id: "a", label: "a", tool_name: "t1", interval_seconds: 60 });
    const b = createWatcher({ agent_id: "a", label: "b", tool_name: "t2", interval_seconds: 60 });
    // Fast-forward `asOf` past whichever watcher's next_run_at is later —
    // they're created back-to-back so the timestamps may differ by 1+ ms
    // depending on host clock granularity (this previously flaked in CI).
    const latestNextRun = Math.max(Date.parse(a.next_run_at), Date.parse(b.next_run_at));
    const asOf = new Date(latestNextRun + 1);
    const due = getDueWatchers(asOf);
    expect(due.map((w) => w.id)).toContain(a.id);
    expect(due.map((w) => w.id)).toContain(b.id);

    // Disabling removes it from the due set.
    updateWatcher(b.id, { enabled: false });
    const due2 = getDueWatchers(asOf);
    expect(due2.map((w) => w.id)).toContain(a.id);
    expect(due2.map((w) => w.id)).not.toContain(b.id);
  });

  it("recordWatcherPoll updates fingerprint + advances next_run_at; last_fired_at only on fire", () => {
    const w = createWatcher({ agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60 });
    const beforeMs = Date.parse(w.next_run_at);
    recordWatcherPoll({ id: w.id, fingerprint: "abc", result: "raw", fired: false });
    const after = getWatcher(w.id)!;
    expect(after.last_fingerprint).toBe("abc");
    expect(after.last_result).toBe("raw");
    expect(after.last_run_at).not.toBeNull();
    expect(after.last_fired_at).toBeNull();
    expect(Date.parse(after.next_run_at)).toBeGreaterThanOrEqual(beforeMs);

    recordWatcherPoll({ id: w.id, fingerprint: "def", result: "changed", fired: true });
    const after2 = getWatcher(w.id)!;
    expect(after2.last_fingerprint).toBe("def");
    expect(after2.last_fired_at).not.toBeNull();
  });

  it("recordWatcherPollError stores last_error + advances next_run_at", () => {
    const w = createWatcher({ agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60 });
    recordWatcherPollError(w.id, "boom");
    const after = getWatcher(w.id)!;
    expect(after.last_error).toBe("boom");
    expect(after.last_run_at).not.toBeNull();
  });

  it("updateWatcher only recomputes next_run_at when interval changes", () => {
    const w = createWatcher({ agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60 });
    const beforeNext = w.next_run_at;
    // Label-only change preserves the schedule.
    const labelUpdated = updateWatcher(w.id, { label: "renamed" })!;
    expect(labelUpdated.label).toBe("renamed");
    expect(labelUpdated.next_run_at).toBe(beforeNext);

    // Interval change advances next_run_at.
    const intervalUpdated = updateWatcher(w.id, { interval_seconds: 300 })!;
    expect(intervalUpdated.interval_seconds).toBe(300);
    expect(intervalUpdated.next_run_at).not.toBe(beforeNext);
  });

  it("updateWatcher re-assigns the watcher to a different agent without rescheduling", () => {
    const w = createWatcher({ agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60 });
    const beforeNext = w.next_run_at;
    const reassigned = updateWatcher(w.id, { agent_id: "b" })!;
    expect(reassigned.agent_id).toBe("b");
    expect(reassigned.next_run_at).toBe(beforeNext);
    expect(reassigned.label).toBe("w");
  });

  // ADR-0030 — per-watcher reaction prompt.
  describe("reaction_prompt (ADR-0030)", () => {
    it("defaults to null when not provided", () => {
      const w = createWatcher({ agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60 });
      expect(w.reaction_prompt).toBeNull();
      expect(getWatcher(w.id)!.reaction_prompt).toBeNull();
    });

    it("persists a non-empty prompt and trims surrounding whitespace", () => {
      const w = createWatcher({
        agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60,
        reaction_prompt: "  open a Jira ticket on change  ",
      });
      expect(w.reaction_prompt).toBe("open a Jira ticket on change");
      expect(getWatcher(w.id)!.reaction_prompt).toBe("open a Jira ticket on change");
    });

    it("treats empty / whitespace-only as null (fall back to default directive)", () => {
      const w1 = createWatcher({
        agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60,
        reaction_prompt: "",
      });
      expect(w1.reaction_prompt).toBeNull();

      deleteWatcher(w1.id);
      const w2 = createWatcher({
        agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60,
        reaction_prompt: "   \n  ",
      });
      expect(w2.reaction_prompt).toBeNull();
    });

    it("rejects prompts over 4000 characters", () => {
      expect(() => createWatcher({
        agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60,
        reaction_prompt: "x".repeat(4001),
      })).toThrow(/<= 4000/);
    });

    it("updateWatcher: undefined leaves the value, null clears it, string sets it", () => {
      const w = createWatcher({
        agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60,
        reaction_prompt: "initial",
      });
      // undefined → leave alone.
      const a = updateWatcher(w.id, { label: "renamed" })!;
      expect(a.reaction_prompt).toBe("initial");

      // string → set.
      const b = updateWatcher(w.id, { reaction_prompt: "updated" })!;
      expect(b.reaction_prompt).toBe("updated");

      // null → clear.
      const c = updateWatcher(w.id, { reaction_prompt: null })!;
      expect(c.reaction_prompt).toBeNull();
    });
  });

  // ADR-0031 — discriminated reaction column (agent_prompt | script).
  describe("reaction kind discriminator (ADR-0031)", () => {
    it("defaults to reaction_kind='agent_prompt' with both script columns null", () => {
      const w = createWatcher({ agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60 });
      expect(w.reaction_kind).toBe("agent_prompt");
      expect(w.reaction_script).toBeNull();
      expect(w.reaction_script_args).toBeNull();
    });

    it("creates a script-kind watcher with prompt forced to null", () => {
      const w = createWatcher({
        agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60,
        reaction_kind: "script",
        reaction_script: "reaction.test",
        reaction_script_args: { title: "hi" },
        // even if a prompt is supplied, the discriminator forces it null.
        reaction_prompt: "ignored on script kind",
      });
      expect(w.reaction_kind).toBe("script");
      expect(w.reaction_script).toBe("reaction.test");
      expect(w.reaction_script_args).toBe(JSON.stringify({ title: "hi" }));
      expect(w.reaction_prompt).toBeNull();
    });

    it("rejects reaction_kind='script' without reaction_script", () => {
      expect(() => createWatcher({
        agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60,
        reaction_kind: "script",
      })).toThrow(/requires reaction_script/);
    });

    it("rejects a reaction_script that lacks the reaction. prefix", () => {
      expect(() => createWatcher({
        agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60,
        reaction_kind: "script",
        reaction_script: "documents.reindex_local_file",
      })).toThrow(/must begin with "reaction\."/);
    });

    it("rejects a reaction_script that is not registered", () => {
      expect(() => createWatcher({
        agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60,
        reaction_kind: "script",
        reaction_script: "reaction.nonexistent",
      })).toThrow(/not registered/);
    });

    it("rejects non-object reaction_script_args", () => {
      expect(() => createWatcher({
        agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60,
        reaction_kind: "script",
        reaction_script: "reaction.test",
        // @ts-expect-error — runtime guard intentionally tested
        reaction_script_args: ["a", "b"],
      })).toThrow(/JSON object/);
    });

    it("updateWatcher: switching kind to 'script' clears reaction_prompt", () => {
      const w = createWatcher({
        agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60,
        reaction_prompt: "before",
      });
      const updated = updateWatcher(w.id, {
        reaction_kind: "script",
        reaction_script: "reaction.test",
        reaction_script_args: { x: 1 },
      })!;
      expect(updated.reaction_kind).toBe("script");
      expect(updated.reaction_prompt).toBeNull();
      expect(updated.reaction_script).toBe("reaction.test");
      expect(updated.reaction_script_args).toBe(JSON.stringify({ x: 1 }));
    });

    it("updateWatcher: switching kind back to 'agent_prompt' clears script columns", () => {
      const w = createWatcher({
        agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60,
        reaction_kind: "script",
        reaction_script: "reaction.test",
        reaction_script_args: { x: 1 },
      });
      const updated = updateWatcher(w.id, {
        reaction_kind: "agent_prompt",
        reaction_prompt: "now an agent prompt",
      })!;
      expect(updated.reaction_kind).toBe("agent_prompt");
      expect(updated.reaction_prompt).toBe("now an agent prompt");
      expect(updated.reaction_script).toBeNull();
      expect(updated.reaction_script_args).toBeNull();
    });

    it("updateWatcher: kind-preserving patch only allows the matching branch's fields", () => {
      const w = createWatcher({
        agent_id: "a", label: "w", tool_name: "t", interval_seconds: 60,
        reaction_kind: "script",
        reaction_script: "reaction.test",
      });
      // While in 'script' mode, reaction_prompt patches are ignored —
      // the column is forced to null by resolveReaction.
      const a = updateWatcher(w.id, { reaction_script_args: { y: 2 } })!;
      expect(a.reaction_script_args).toBe(JSON.stringify({ y: 2 }));
      expect(a.reaction_prompt).toBeNull();

      // Cannot clear reaction_script while still in 'script' mode.
      expect(() => updateWatcher(w.id, { reaction_script: null })).toThrow(/cannot be cleared/);
    });
  });
});
