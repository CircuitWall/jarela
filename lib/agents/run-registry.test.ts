import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startRun, finishRun, getRun, broadcast, waitForRun, pushSteering, drainSteering, abortRun } from "./run-registry";
import { resetConfigCache } from "@/lib/env/config";
import type { StreamChunk } from "./base";

const delta = (s: string): StreamChunk => ({ type: "text_delta", data: { delta: s } } as StreamChunk);
const toolCall = (id: string): StreamChunk => ({ type: "tool_call", data: { id, name: "x", arguments: {} } } as StreamChunk);
const toolResult = (id: string): StreamChunk => ({ type: "tool_result", data: { id, name: "x", result: null } } as StreamChunk);
const heartbeat = (): StreamChunk => ({ type: "heartbeat", data: {} } as StreamChunk);

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

  it("watchdog termination chunks land in the buffer (so reconnects replay them)", () => {
    const prev = process.env.JARELA_RUN_IDLE_MS;
    process.env.JARELA_RUN_IDLE_MS = "5000";
    try {
      const tid = `t-idle-buf-${Date.now()}`;
      const run = startRun(tid, null);
      broadcast(run, delta("partial text"));
      vi.advanceTimersByTime(5_000 + 10);

      // Buffered events: text_delta from broadcast(), then watchdog's
      // synthetic error + done. A reconnecting subscriber re-reads the
      // same buffer and sees the failure even if it missed the live event.
      const types = run.events.map((e) => e.type);
      expect(types).toEqual(["text_delta", "error", "done"]);
    } finally {
      if (prev === undefined) delete process.env.JARELA_RUN_IDLE_MS;
      else process.env.JARELA_RUN_IDLE_MS = prev;
    }
  });

  it("pauses idle watchdog while a tool_call is in flight", () => {
    const prev = process.env.JARELA_RUN_IDLE_MS;
    process.env.JARELA_RUN_IDLE_MS = "5000";
    try {
      const tid = `t-tool-pause-${Date.now()}`;
      const run = startRun(tid, null);
      broadcast(run, toolCall("call-1"));
      // Tool runs silently for 4× the idle budget. Without the pause the
      // watchdog would fire at 5s; with it, the run stays alive.
      vi.advanceTimersByTime(20_000);
      expect(run.status).toBe("running");
      // Tool resolves — idle clock starts counting from here.
      broadcast(run, toolResult("call-1"));
      vi.advanceTimersByTime(2_000);
      expect(run.status).toBe("running");
      // Once silence resumes past idleMs after the tool_result, watchdog fires.
      vi.advanceTimersByTime(5_000 + 10);
      expect(run.status).toBe("error");
    } finally {
      if (prev === undefined) delete process.env.JARELA_RUN_IDLE_MS;
      else process.env.JARELA_RUN_IDLE_MS = prev;
    }
  });

  it("only un-pauses the idle watchdog when ALL inflight tools resolve", () => {
    const prev = process.env.JARELA_RUN_IDLE_MS;
    process.env.JARELA_RUN_IDLE_MS = "5000";
    try {
      const tid = `t-tool-parallel-${Date.now()}`;
      const run = startRun(tid, null);
      broadcast(run, toolCall("a"));
      broadcast(run, toolCall("b"));
      vi.advanceTimersByTime(20_000);
      expect(run.status).toBe("running");
      // Resolving only one of two — still paused.
      broadcast(run, toolResult("a"));
      vi.advanceTimersByTime(20_000);
      expect(run.status).toBe("running");
      // Resolving the second un-pauses.
      broadcast(run, toolResult("b"));
      vi.advanceTimersByTime(5_000 + 10);
      expect(run.status).toBe("error");
    } finally {
      if (prev === undefined) delete process.env.JARELA_RUN_IDLE_MS;
      else process.env.JARELA_RUN_IDLE_MS = prev;
    }
  });

  it("wall-clock watchdog discounts tool-execution time from elapsed", () => {
    const prevIdle = process.env.JARELA_RUN_IDLE_MS;
    const prevMax = process.env.JARELA_RUN_MAX_MS;
    process.env.JARELA_RUN_IDLE_MS = "5000";
    process.env.JARELA_RUN_MAX_MS = "60000";
    try {
      const tid = `t-tool-wall-${Date.now()}`;
      const run = startRun(tid, null);
      // Tool runs for 10× the wall-clock budget. Per-tool timeouts are the
      // tool's responsibility (exec.ts caps at 60s, MCP SDKs at their own
      // limits); the agent's wall-clock bounds agent + provider time and
      // must NOT count tool execution against it.
      broadcast(run, toolCall("slow"));
      vi.advanceTimersByTime(600_000);
      expect(run.status).toBe("running");
      // Tool resolves — the agent has burned 0ms of its own budget so far.
      broadcast(run, toolResult("slow"));
      // Now silence stretches past the wall-clock; watchdog fires once
      // effective elapsed (post-tool) crosses runMaxMs. The idle watchdog
      // would fire first at 5s, so this assert covers both: at 60s+10
      // post-resolve the run is dead either way.
      vi.advanceTimersByTime(60_000 + 10);
      expect(run.status).toBe("error");
    } finally {
      if (prevIdle === undefined) delete process.env.JARELA_RUN_IDLE_MS;
      else process.env.JARELA_RUN_IDLE_MS = prevIdle;
      if (prevMax === undefined) delete process.env.JARELA_RUN_MAX_MS;
      else process.env.JARELA_RUN_MAX_MS = prevMax;
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

  // Regression for the user-reported "2-min hang during silent tool-arg
  // streaming" symptom: while the model is mid-way through emitting a
  // large file_write body, each AIMessageChunk carries only partial
  // tool-call args and produces no text_delta / tool_call / tool_result.
  // llm.ts now yields a "heartbeat" chunk for each such silent chunk so
  // the idle watchdog sees forward progress. Heartbeats must (a) reset
  // last_chunk_at and (b) be dropped before subscribers / buffer so the
  // SSE wire stays clean.
  it("heartbeat chunks reset the idle watchdog without buffering or fan-out", () => {
    const prev = process.env.JARELA_RUN_IDLE_MS;
    process.env.JARELA_RUN_IDLE_MS = "5000";
    try {
      const tid = `t-heartbeat-${Date.now()}`;
      const run = startRun(tid, null);
      const seen: StreamChunk[] = [];
      run.subscribers.add((chunk) => { seen.push(chunk); });

      // Heartbeats every 2s for 12s — total elapsed > idleMs but never
      // idle for >5s in a row. Without the timestamp bump in broadcast()
      // the watchdog would fire at 5s.
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(2_000);
        broadcast(run, heartbeat());
      }
      expect(run.status).toBe("running");
      // Heartbeats must NOT appear in the replay buffer (otherwise a
      // reconnecting subscriber would receive a flood of ticks) and must
      // NOT reach live subscribers (the SSE wire stays clean).
      expect(run.events).toHaveLength(0);
      expect(seen).toHaveLength(0);

      // Once heartbeats stop, the watchdog still fires normally.
      vi.advanceTimersByTime(5_000 + 10);
      expect(run.status).toBe("error");
    } finally {
      if (prev === undefined) delete process.env.JARELA_RUN_IDLE_MS;
      else process.env.JARELA_RUN_IDLE_MS = prev;
    }
  });
});

// Regression for the user-reported "fired a scheduled task, came back to
// the agent, looked idle even though it was running" symptom. Triggers /
// scheduler / watcher submit work through Next's `after()` + the per-
// thread queue, so there's a real delay between the user clicking "Run
// now" and `startRun` registering the entry. A GET subscriber that arrives
// in that window used to immediately get a synthetic `done`; `waitForRun`
// holds it open until the registry catches up.
describe("waitForRun", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("resolves immediately when a run is already active", async () => {
    const tid = `t-wait-existing-${Date.now()}`;
    const run = startRun(tid, null);
    await expect(waitForRun(tid, 5_000)).resolves.toBe(run);
    finishRun(run, "done");
  });

  it("resolves with the new run when startRun fires inside the window", async () => {
    const tid = `t-wait-resolve-${Date.now()}`;
    const pending = waitForRun(tid, 5_000);
    // Simulate the queue-then-startRun delay.
    vi.advanceTimersByTime(100);
    const run = startRun(tid, null);
    await expect(pending).resolves.toBe(run);
    finishRun(run, "done");
  });

  it("resolves to null after timeout and cleans up so a late startRun is a no-op", async () => {
    const tid = `t-wait-timeout-${Date.now()}`;
    const pending = waitForRun(tid, 1_000);
    await vi.advanceTimersByTimeAsync(1_000 + 10);
    await expect(pending).resolves.toBeNull();
    // Late startRun must not flip the already-resolved promise; the
    // cleanest signal is that a fresh waitForRun after startRun returns
    // the new run synchronously (i.e. there was no stale waiter to
    // resolve against).
    const run = startRun(tid, null);
    await expect(waitForRun(tid, 0)).resolves.toBe(run);
    finishRun(run, "done");
  });
});

describe("steering queue (ADR-0080)", () => {
  it("queues messages on the active run and drains them in arrival order", () => {
    const tid = `t-steer-${Date.now()}`;
    const run = startRun(tid, null);
    expect(pushSteering(tid, "skip the tests")).toBe(true);
    expect(pushSteering(tid, "and keep the API stable")).toBe(true);
    expect(drainSteering(tid)).toEqual(["skip the tests", "and keep the API stable"]);
    // Draining is destructive so the next model call doesn't see them twice.
    expect(drainSteering(tid)).toEqual([]);
    finishRun(run, "done");
  });

  it("trims and rejects blank messages", () => {
    const tid = `t-steer-blank-${Date.now()}`;
    const run = startRun(tid, null);
    expect(pushSteering(tid, "   ")).toBe(false);
    expect(pushSteering(tid, "  real  ")).toBe(true);
    expect(drainSteering(tid)).toEqual(["real"]);
    finishRun(run, "done");
  });

  it("refuses to steer when there is no run, or the run already ended", () => {
    const tid = `t-steer-none-${Date.now()}`;
    expect(pushSteering(tid, "hello")).toBe(false);
    const run = startRun(tid, null);
    finishRun(run, "done");
    expect(pushSteering(tid, "hello")).toBe(false);
  });

  // Stop is the only interrupt, so a message racing the abort must fall back
  // to starting a fresh turn rather than vanishing into a dying run.
  it("refuses to steer a run that is already aborting", () => {
    const tid = `t-steer-abort-${Date.now()}`;
    const run = startRun(tid, null);
    abortRun(tid);
    expect(pushSteering(tid, "too late")).toBe(false);
    finishRun(run, "done");
  });
});
