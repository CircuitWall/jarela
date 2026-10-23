import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/lifecycle/system-signals", () => ({ requestSystemSignalDispatch: vi.fn() }));
vi.mock("../support/async-results", () => ({
  startOwnedAsyncCall: vi.fn(() => ({ owned: true, key: "result-key" })),
  completeAsyncCall: vi.fn(),
  failAsyncCall: vi.fn(),
  consumeAsyncResult: vi.fn(),
}));

const jobs = await import("./claude-delegate-jobs");

const start = (id: string, provider: "claude" | "codex" = "claude") =>
  jobs.createJob(id, { provider, projectKey: "p", sessionId: "s", parentMessage: "task", resumed: false });

beforeEach(() => {
  jobs._resetDelegateJobs();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  jobs._resetDelegateJobs();
});

describe("delegate job registry on the agent path", () => {
  it("keeps a finished job pollable for a while after completion", () => {
    start("j1");
    jobs.completeJob("j1", { ok: true });
    vi.advanceTimersByTime(30 * 60_000);
    start("j2");
    expect(jobs.getJob("j1", "claude")?.status).toBe("done");
  });

  it("evicts finished jobs after the retention window so long-running servers do not grow forever", () => {
    start("old-done");
    jobs.completeJob("old-done", { ok: true });
    start("old-error");
    jobs.failJob("old-error", "boom");
    start("old-cancelled");
    jobs.cancelJob("old-cancelled", "claude");

    vi.advanceTimersByTime(jobs.FINISHED_JOB_TTL_MS + 1);
    start("fresh");

    expect(jobs.getJob("old-done", "claude")).toBeNull();
    expect(jobs.getJob("old-error", "claude")).toBeNull();
    expect(jobs.getJob("old-cancelled", "claude")).toBeNull();
    expect(jobs.getJob("fresh", "claude")?.status).toBe("running");
  });

  it("never evicts a running job, however old", () => {
    start("long-runner", "codex");
    vi.advanceTimersByTime(jobs.FINISHED_JOB_TTL_MS * 10);
    start("other");
    expect(jobs.getJob("long-runner", "codex")?.status).toBe("running");
    expect(jobs.cancelJob("long-runner", "codex")).toBe(true);
  });

  it("caps the number of retained finished jobs, dropping the oldest first", () => {
    for (let i = 0; i < jobs.MAX_FINISHED_JOBS + 5; i++) {
      start(`j${i}`);
      vi.advanceTimersByTime(1);
      jobs.completeJob(`j${i}`, i);
    }
    start("trigger");
    expect(jobs.getJob("j0", "claude")).toBeNull();
    expect(jobs.getJob("j4", "claude")).toBeNull();
    expect(jobs.getJob("j5", "claude")?.status).toBe("done");
    expect(jobs.getJob(`j${jobs.MAX_FINISHED_JOBS + 4}`, "claude")?.status).toBe("done");
  });

  it("ignores late completion events after cancellation", () => {
    start("c1");
    expect(jobs.cancelJob("c1", "claude")).toBe(true);
    jobs.completeJob("c1", { late: true });
    jobs.failJob("c1", "late error");
    jobs.appendStep("c1", "late step");
    expect(jobs.getJob("c1", "claude")).toMatchObject({ status: "cancelled", result: null, error: null, steps: [] });
    expect(jobs.cancelJob("c1", "claude")).toBe(false);
  });

  it("treats a job id from the other provider or another thread as missing", () => {
    jobs.createJob("t1", { provider: "claude", projectKey: "p", sessionId: "s", parentMessage: "m", resumed: false },
      { configurable: { thread_id: "thread-a" } });
    expect(jobs.getJob("t1", "codex")).toBeNull();
    expect(jobs.cancelJob("t1", "codex")).toBe(false);
    expect(jobs.getJobForTool("t1", "claude", "thread-b")).toBeNull();
    expect(jobs.getJobForTool("t1", "claude", "thread-a")?.status).toBe("running");
  });
});
