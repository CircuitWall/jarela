import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env/config", () => ({ getConfig: () => ({ compactionTimeoutMs: 60_000 }) }));

import {
  CompactionTimeoutError,
  __resetCompactionAttemptsForTests,
  currentCompaction,
  getCompactionAttempt,
  isCompactionRunning,
  runTrackedCompaction,
  type CompactionAttempt,
} from "./thread-compaction-state";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("thread-compaction-state", () => {
  beforeEach(() => __resetCompactionAttemptsForTests());
  afterEach(() => vi.useRealTimers());

  it("registers the attempt synchronously and releases it when it settles", async () => {
    const gate = deferred<string>();
    const run = runTrackedCompaction("t1", "manual", 5, () => gate.promise);
    expect(isCompactionRunning("t1")).toBe(true);
    expect(isCompactionRunning("t1", "manual")).toBe(true);
    expect(getCompactionAttempt("t1", "manual")?.boundarySeq).toBe(5);
    gate.resolve("ok");
    await expect(run).resolves.toBe("ok");
    expect(isCompactionRunning("t1")).toBe(false);
  });

  it("releases the attempt when the run throws", async () => {
    await expect(runTrackedCompaction("t1", "auto", 1, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(isCompactionRunning("t1")).toBe(false);
  });

  it("times out, rejects, and stops the attempt from being current", async () => {
    vi.useFakeTimers();
    let seen: CompactionAttempt | null = null;
    const run = runTrackedCompaction("t1", "refresh", null, (a) => { seen = a; return new Promise<void>(() => {}); }, 1_000);
    const settled = expect(run).rejects.toBeInstanceOf(CompactionTimeoutError);
    expect(seen!.isCurrent()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    expect(seen!.isCurrent()).toBe(false);
    expect(isCompactionRunning("t1")).toBe(false);
  });

  it("reports the most significant compaction first", () => {
    const hold = () => new Promise<void>(() => {});
    void runTrackedCompaction("t1", "refresh", null, hold);
    void runTrackedCompaction("t1", "auto", 3, hold);
    expect(currentCompaction("t1")?.kind).toBe("auto");
    void runTrackedCompaction("t1", "manual", 4, hold);
    expect(currentCompaction("t1")?.kind).toBe("manual");
    expect(currentCompaction("t2")).toBeNull();
  });

  it("invalidates an attempt replaced by a newer one of the same kind", async () => {
    let first: CompactionAttempt | null = null;
    const gate = deferred<void>();
    const a = runTrackedCompaction("t1", "auto", 1, (att) => { first = att; return gate.promise; });
    const b = runTrackedCompaction("t1", "auto", 2, () => new Promise<void>(() => {}));
    expect(first!.isCurrent()).toBe(false);
    gate.resolve();
    await a;
    // Settling the stale attempt must not release the newer one.
    expect(getCompactionAttempt("t1", "auto")?.boundarySeq).toBe(2);
    void b;
  });

  it("shares state across module instances", async () => {
    void runTrackedCompaction("t1", "manual", 9, () => new Promise<void>(() => {}));
    vi.resetModules();
    const fresh = await import("./thread-compaction-state");
    expect(fresh.isCompactionRunning("t1", "manual")).toBe(true);
  });
});
