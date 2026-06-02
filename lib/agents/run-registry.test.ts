import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startRun, finishRun, getRun, broadcast } from "./run-registry";
import { resetConfigCache } from "@/lib/env/config";
import type { StreamChunk } from "./base";

const delta = (s: string): StreamChunk => ({ type: "text_delta", data: { delta: s } } as StreamChunk);

describe("run-registry watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Tests mutate JARELA_RUN_*_MS at runtime; the config cache otherwise
    // pins the snapshot read at module init.
    resetConfigCache();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetConfigCache();
  });

  it("force-evicts a leaked 'running' entry after JARELA_RUN_MAX_MS", () => {
    const prev = process.env.JARELA_RUN_MAX_MS;
    process.env.JARELA_RUN_MAX_MS = "60000";
    try {
      const tid = `t-leak-${Date.now()}`;
      const run = startRun(tid, null);
      expect(getRun(tid)).toBe(run);
      expect(run.status).toBe("running");

      // Driver never calls finishRun(). Without the watchdog the entry
      // would sit as "running" forever, 409'ing every subsequent submit.
      vi.advanceTimersByTime(60_000 + 10);

      expect(run.status).toBe("error");
      // Still in the map briefly (TTL-evicted 5 min after finishRun),
      // but no longer blocks new runs because status is no longer "running".
      const stillThere = getRun(tid);
      expect(stillThere === null || stillThere.status === "error").toBe(true);

      // A fresh startRun for the same thread must now succeed.
      expect(() => startRun(tid, null)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.JARELA_RUN_MAX_MS;
      else process.env.JARELA_RUN_MAX_MS = prev;
    }
  });

  it("does not clobber a run that finishes normally before the watchdog", () => {
    const prev = process.env.JARELA_RUN_MAX_MS;
    process.env.JARELA_RUN_MAX_MS = "60000";
    try {
      const tid = `t-ok-${Date.now()}`;
      const run = startRun(tid, null);
      finishRun(run, "done");
      expect(run.status).toBe("done");
      vi.advanceTimersByTime(60_000 + 10);
      // Watchdog must not have flipped a "done" run to "error".
      expect(run.status).toBe("done");
    } finally {
      if (prev === undefined) delete process.env.JARELA_RUN_MAX_MS;
      else process.env.JARELA_RUN_MAX_MS = prev;
    }
  });

  it("force-finishes a stalled run after JARELA_RUN_IDLE_MS of no progress", () => {
    const prev = process.env.JARELA_RUN_IDLE_MS;
    process.env.JARELA_RUN_IDLE_MS = "5000";
    try {
      const tid = `t-idle-${Date.now()}`;
      const run = startRun(tid, null);
      vi.advanceTimersByTime(5_000 + 10);
      expect(run.status).toBe("error");
    } finally {
      if (prev === undefined) delete process.env.JARELA_RUN_IDLE_MS;
      else process.env.JARELA_RUN_IDLE_MS = prev;
    }
  });

  it("does not fire idle watchdog while broadcast keeps streaming", () => {
    const prev = process.env.JARELA_RUN_IDLE_MS;
    process.env.JARELA_RUN_IDLE_MS = "5000";
    try {
      const tid = `t-stream-${Date.now()}`;
      const run = startRun(tid, null);
      // Stream a chunk every 2s for 12s — total elapsed > idleMs but
      // never idle for >5s in a row.
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(2_000);
        broadcast(run, delta("x"));
      }
      expect(run.status).toBe("running");
      // Now go quiet and confirm it fires.
      vi.advanceTimersByTime(5_000 + 10);
      expect(run.status).toBe("error");
    } finally {
      if (prev === undefined) delete process.env.JARELA_RUN_IDLE_MS;
      else process.env.JARELA_RUN_IDLE_MS = prev;
    }
  });
});
