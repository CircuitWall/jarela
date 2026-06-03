import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startRun, finishRun, getRun, broadcast, subscribe } from "./run-registry";
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

  // Regression for the user-reported "hanging" symptom: model went silent
  // mid-turn, watchdog fired at 90s, but the watchdog's error never
  // reached the client because broadcast()'s status guard dropped any
  // chunk delivered after finishRun() flipped status to "error". The fix
  // emits the typed error chunk BEFORE finishRun, so subscribers see it.
  it("idle watchdog emits a typed error chunk to subscribers before finishing", () => {
    const prev = process.env.JARELA_RUN_IDLE_MS;
    process.env.JARELA_RUN_IDLE_MS = "5000";
    try {
      const tid = `t-idle-emit-${Date.now()}`;
      const run = startRun(tid, null);
      const seen: Array<{ type: string; code?: string }> = [];
      run.subscribers.add((chunk) => {
        seen.push({
          type: chunk.type,
          code: (chunk.data as { code?: string }).code,
        });
      });

      vi.advanceTimersByTime(5_000 + 10);

      // Subscriber must receive a typed error + done pair. Without these
      // chunks the client's EventSource sees a silent connection close
      // and the chat bubble keeps spinning forever.
      expect(seen).toEqual([
        { type: "error", code: "run_idle_timeout" },
        { type: "done", code: undefined },
      ]);
      expect(run.status).toBe("error");
    } finally {
      if (prev === undefined) delete process.env.JARELA_RUN_IDLE_MS;
      else process.env.JARELA_RUN_IDLE_MS = prev;
    }
  });

  it("wall-clock watchdog emits a typed error chunk to subscribers before finishing", () => {
    const prev = process.env.JARELA_RUN_MAX_MS;
    process.env.JARELA_RUN_MAX_MS = "60000";
    try {
      const tid = `t-max-emit-${Date.now()}`;
      const run = startRun(tid, null);
      const seen: Array<{ type: string; code?: string }> = [];
      run.subscribers.add((chunk) => {
        seen.push({
          type: chunk.type,
          code: (chunk.data as { code?: string }).code,
        });
      });

      vi.advanceTimersByTime(60_000 + 10);

      expect(seen).toEqual([
        { type: "error", code: "run_max_timeout" },
        { type: "done", code: undefined },
      ]);
      expect(run.status).toBe("error");
    } finally {
      if (prev === undefined) delete process.env.JARELA_RUN_MAX_MS;
      else process.env.JARELA_RUN_MAX_MS = prev;
    }
  });

  it("watchdog termination chunks land in the buffer with seqs (so reconnects replay them)", () => {
    const prev = process.env.JARELA_RUN_IDLE_MS;
    process.env.JARELA_RUN_IDLE_MS = "5000";
    try {
      const tid = `t-idle-buf-${Date.now()}`;
      const run = startRun(tid, null);
      broadcast(run, delta("partial text"));
      vi.advanceTimersByTime(5_000 + 10);

      const types = run.events.map((e) => e.chunk.type);
      // Buffered events: text_delta from broadcast(), then watchdog's
      // synthetic error + done. A reconnecting subscriber gets the same
      // sequence and sees the failure even if it missed the live event.
      expect(types).toEqual(["text_delta", "error", "done"]);
      expect(run.events.map((e) => e.seq)).toEqual([1, 2, 3]);
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

describe("run-registry idempotent terminal guard", () => {
  it("broadcast() drops chunks once the run has transitioned to terminal", () => {
    const tid = `t-term-${Date.now()}`;
    const run = startRun(tid, null);
    const seen: StreamChunk[] = [];
    run.subscribers.add((chunk) => seen.push(chunk));

    broadcast(run, delta("a"));
    expect(seen).toHaveLength(1);

    finishRun(run, "done");
    // Late chunk (e.g. a persistence-error broadcast firing after collectStream
    // already emitted `done`) must not reach subscribers.
    broadcast(run, { type: "error", data: { message: "stale", code: "x" } });
    expect(seen).toHaveLength(1);
    expect(run.events).toHaveLength(1);
  });

  it("subscribe() with sinceSeq=0 replays the full buffer", () => {
    const tid = `t-replay-full-${Date.now()}`;
    const run = startRun(tid, null);
    broadcast(run, delta("a"));
    broadcast(run, delta("b"));
    broadcast(run, delta("c"));

    const seen: Array<{ delta: string; seq: number }> = [];
    subscribe(tid, (chunk, seq) => {
      if (chunk.type === "text_delta") {
        seen.push({ delta: (chunk.data as { delta: string }).delta, seq });
      }
    });

    expect(seen).toEqual([
      { delta: "a", seq: 1 },
      { delta: "b", seq: 2 },
      { delta: "c", seq: 3 },
    ]);
    finishRun(run, "done");
  });

  it("subscribe() with sinceSeq skips already-delivered events on reconnect", () => {
    // Repro of the SSE-replay duplication bug: client received seqs 1..2
    // before EventSource auto-reconnected. The reconnect must NOT replay
    // 1..2 (which would double-render the streaming bubble).
    const tid = `t-replay-skip-${Date.now()}`;
    const run = startRun(tid, null);
    broadcast(run, delta("a"));
    broadcast(run, delta("b"));
    broadcast(run, delta("c"));

    const seen: Array<{ delta: string; seq: number }> = [];
    subscribe(tid, (chunk, seq) => {
      if (chunk.type === "text_delta") {
        seen.push({ delta: (chunk.data as { delta: string }).delta, seq });
      }
    }, 2);

    expect(seen).toEqual([{ delta: "c", seq: 3 }]);
    finishRun(run, "done");
  });

  it("subscribe() with sinceSeq >= last seq replays nothing", () => {
    const tid = `t-replay-empty-${Date.now()}`;
    const run = startRun(tid, null);
    broadcast(run, delta("a"));
    broadcast(run, delta("b"));

    const seen: StreamChunk[] = [];
    subscribe(tid, (chunk) => seen.push(chunk), 99);

    expect(seen).toHaveLength(0);
    finishRun(run, "done");
  });

  it("live broadcasts after subscribe() carry monotonic seqs", () => {
    // Live subscriber must receive seqs that continue the buffered series,
    // so the client's Last-Event-ID stays accurate across the buffer→live
    // boundary.
    const tid = `t-live-seq-${Date.now()}`;
    const run = startRun(tid, null);
    broadcast(run, delta("buffered-1"));
    broadcast(run, delta("buffered-2"));

    const seen: Array<{ delta: string; seq: number }> = [];
    subscribe(tid, (chunk, seq) => {
      if (chunk.type === "text_delta") {
        seen.push({ delta: (chunk.data as { delta: string }).delta, seq });
      }
    }, 0);

    broadcast(run, delta("live-3"));
    broadcast(run, delta("live-4"));

    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    finishRun(run, "done");
  });

  it("finishRun() is idempotent — second call is a no-op", () => {
    const tid = `t-finish-twice-${Date.now()}`;
    const run = startRun(tid, null);
    finishRun(run, "done");
    const firstFinishedAt = run.finished_at;
    expect(run.status).toBe("done");

    // A second finishRun (e.g. from the route's try/finally racing the
    // watchdog) must not flip status, reset finished_at, or re-arm the
    // TTL timer.
    finishRun(run, "error");
    expect(run.status).toBe("done");
    expect(run.finished_at).toBe(firstFinishedAt);
  });
});
