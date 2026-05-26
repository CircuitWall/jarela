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
    // Force `a` to be due now by rewinding its next_run_at via update of interval.
    // (updateWatcher recomputes next_run_at to now + interval when interval changes.)
    // Easier: fast-forward `asOf` to next_run_at + a tick.
    const asOf = new Date(Date.parse(a.next_run_at) + 1);
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
});
