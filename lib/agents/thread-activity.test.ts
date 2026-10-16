import { afterEach, describe, expect, it } from "vitest";
import { finishRun, startRun } from "./run-registry";
import { __resetCompactionAttemptsForTests, runTrackedCompaction } from "./thread-compaction-state";
import { getThreadActivity } from "./thread-activity";

describe("getThreadActivity", () => {
  afterEach(() => __resetCompactionAttemptsForTests());

  it("is idle for a thread with nothing running", () => {
    expect(getThreadActivity(`idle-${Date.now()}`)).toEqual({ run: null, queue_depth: 0, compaction: null, busy: false });
  });

  it("reports the live run phase and drops it once the run finishes", () => {
    const tid = `run-${Date.now()}`;
    const run = startRun(tid, "agent-1");
    const live = getThreadActivity(tid);
    expect(live.busy).toBe(true);
    expect(live.run).toMatchObject({ phase: "starting", label: "Starting…", agent_id: "agent-1" });
    finishRun(run, "done");
    expect(getThreadActivity(tid).run).toBeNull();
  });

  it("reports a compaction with no run as busy", () => {
    const tid = `compact-${Date.now()}`;
    void runTrackedCompaction(tid, "auto", 7, () => new Promise<void>(() => {}), 60_000);
    const snapshot = getThreadActivity(tid);
    expect(snapshot.busy).toBe(true);
    expect(snapshot.run).toBeNull();
    expect(snapshot.compaction).toMatchObject({ kind: "auto", boundary_seq: 7 });
  });
});
