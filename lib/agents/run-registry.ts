import type { StreamChunk } from "./base";
import { getConfig } from "@/lib/env/config";

// In-memory registry of in-flight agent runs, keyed by thread_id. When the user
// switches agents mid-stream, the run keeps going server-side; if they return
// (or open a second tab), they re-attach via subscribe() and see live deltas.
//
// Trade-offs:
// - Single Node process only. Multi-instance deploys would need a shared
//   pubsub (Redis, NATS) — not in scope for a local app.
// - Buffered events are capped to MAX_BUFFERED so a 100k-token response
//   doesn't pin GBs of memory if every chunk lingers. Late attachers see the
//   most recent slice plus all subsequent events.

type Subscriber = (chunk: StreamChunk) => void;

// Read once at module init. JARELA_RUN_BUFFER_SIZE / JARELA_RUN_REGISTRY_TTL_MS
// override the defaults.
const MAX_BUFFERED = getConfig().runBufferSize;
const RECENT_TTL_MS = getConfig().runRegistryTtlMs;
// Idle (no-progress) ceiling and wall-clock ceiling: read fresh per-run
// from getConfig() so non-restart-required env reloads take effect.
function runIdleMs(): number { return getConfig().runIdleMs; }
function runMaxMs(): number { return getConfig().runMaxMs; }

export interface ActiveRun {
  thread_id: string;
  agent_id: string | null;
  started_at: number;
  finished_at: number | null;
  status: "running" | "done" | "error";
  events: StreamChunk[];
  subscribers: Set<Subscriber>;
  // Final assistant text — useful for notification body without replaying every event.
  final_text: string;
  // Server-side abort: when the user clicks Stop (or the last client
  // disconnects), we signal this controller so the LangGraph stream cancels
  // itself instead of running to completion in the background.
  abort: AbortController;
  // Last activity timestamp — bumped on every broadcast() so the idle
  // watchdog can tell live progress from a wedged stream.
  last_chunk_at: number;
}

const runs = new Map<string, ActiveRun>();

export function startRun(thread_id: string, agent_id: string | null): ActiveRun {
  // If a stale completed run exists, drop it before starting a new one.
  const existing = runs.get(thread_id);
  if (existing && existing.status === "running") {
    throw new Error(`A run is already active for thread ${thread_id}`);
  }
  const now = Date.now();
  const run: ActiveRun = {
    thread_id,
    agent_id,
    started_at: now,
    finished_at: null,
    status: "running",
    events: [],
    subscribers: new Set(),
    final_text: "",
    abort: new AbortController(),
    last_chunk_at: now,
  };
  runs.set(thread_id, run);
  scheduleIdleWatchdog(run);
  scheduleMaxWatchdog(run);
  return run;
}

// Synthesise a typed error chunk for the watchdog termination paths and
// fan it out to subscribers BEFORE flipping `status` to "error". The order
// matters: `broadcast()`'s status guard drops any chunk delivered after
// `finishRun()` has run, so calling finishRun first would silently swallow
// the error and the client's EventSource would just see the connection
// close with no terminal event — bubble keeps spinning, no toast. Doing
// it the other way around lets the client receive a real error event,
// render a "Run timed out" toast, and (if the consumer wires it up)
// trigger an auto-retry path. Followed by `done` so the consumer's
// for-await loop can break cleanly without waiting for an EOF.
function emitWatchdogTermination(
  run: ActiveRun,
  code: "run_idle_timeout" | "run_max_timeout",
  message: string,
): void {
  if (run.status !== "running") return;
  // Direct registry mutation so the broadcast goes through the regular
  // path (subscribers + buffer + seq stamp) without re-entering any of
  // the watchdog scheduling. Mirrors broadcast() but bypasses the
  // status check we'd otherwise be racing against.
  run.last_chunk_at = Date.now();
  const errChunk: StreamChunk = { type: "error", data: { message, code } };
  if (run.events.length < MAX_BUFFERED) run.events.push(errChunk);
  for (const fn of run.subscribers) {
    try { fn(errChunk); } catch { /* subscriber errored, ignore */ }
  }
  // Pair with a synthetic `done` so the client's consume() loop breaks
  // on a terminal event rather than waiting for the EventSource to close.
  const doneChunk: StreamChunk = { type: "done", data: {} };
  if (run.events.length < MAX_BUFFERED) run.events.push(doneChunk);
  for (const fn of run.subscribers) {
    try { fn(doneChunk); } catch { /* */ }
  }
}

// Self-rearming idle watchdog. Fires when no chunk has arrived for
// `idleMs`; otherwise reschedules itself for `(last_chunk_at + idleMs) -
// now`. We never carry a handle on the run — the closure just bails if
// the run is no longer the registry's entry or no longer running.
function scheduleIdleWatchdog(run: ActiveRun): void {
  const idleMs = runIdleMs();
  const fireIn = Math.max(0, (run.last_chunk_at + idleMs) - Date.now());
  setTimeout(() => {
    const cur = runs.get(run.thread_id);
    if (cur !== run) return;
    if (run.status !== "running") return;
    const idle = Date.now() - run.last_chunk_at;
    if (idle < idleMs) {
      scheduleIdleWatchdog(run);
      return;
    }
    console.warn(`[run-registry] idle watchdog: force-finishing stalled run for thread ${run.thread_id} after ${idle}ms of no progress`);
    emitWatchdogTermination(
      run,
      "run_idle_timeout",
      `Run timed out — no progress for ${Math.round(idle / 1000)}s. The provider stream went silent before the agent finished. Try again, or split the request into smaller steps.`,
    );
    try { run.abort.abort("run_idle_timeout"); } catch { /* */ }
    finishRun(run, "error");
  }, fireIn).unref?.();
}

function scheduleMaxWatchdog(run: ActiveRun): void {
  const max = runMaxMs();
  setTimeout(() => {
    const cur = runs.get(run.thread_id);
    if (cur !== run) return;
    if (run.status !== "running") return;
    console.warn(`[run-registry] wall-clock watchdog: force-finishing run for thread ${run.thread_id} after ${max}ms`);
    emitWatchdogTermination(
      run,
      "run_max_timeout",
      `Run exceeded the wall-clock limit (${Math.round(max / 1000)}s). The agent was force-stopped. Try a smaller scope or raise JARELA_RUN_MAX_MS if this is expected.`,
    );
    try { run.abort.abort("run_watchdog_timeout"); } catch { /* */ }
    finishRun(run, "error");
  }, max).unref?.();
}

export function broadcast(run: ActiveRun, chunk: StreamChunk): void {
  // Identity-check: a superseded run must not smear trailing chunks onto
  // the replacement entry in the registry.
  if (runs.get(run.thread_id) !== run) return;
  run.last_chunk_at = Date.now();
  if (chunk.type === "text_delta") {
    run.final_text += (chunk.data.delta as string) ?? "";
  }
  if (run.events.length < MAX_BUFFERED) {
    run.events.push(chunk);
  }
  for (const fn of run.subscribers) {
    try { fn(chunk); } catch { /* subscriber errored, ignore */ }
  }
}

export function finishRun(run: ActiveRun, status: "done" | "error"): void {
  // Identity-check: a stale run finishing late must not flip the
  // replacement's status or evict it from the registry.
  if (runs.get(run.thread_id) !== run) return;
  run.status = status;
  run.finished_at = Date.now();
  // Drop subscribers — late attachers should NOT keep getting events on a
  // dead run. They'll get the buffered events on subscribe and that's it.
  run.subscribers.clear();
  // Auto-evict after TTL so memory doesn't grow with every conversation.
  setTimeout(() => {
    const cur = runs.get(run.thread_id);
    if (cur === run) runs.delete(run.thread_id);
  }, RECENT_TTL_MS).unref?.();
}

export function getRun(thread_id: string): ActiveRun | null {
  return runs.get(thread_id) ?? null;
}

// Signal the agent stream to cancel. The stream loop in the route is wired
// to listen on the AbortController and exit early, emitting an error chunk
// the client (and the queue-drain hook) can react to. Idempotent.
export function abortRun(thread_id: string, reason = "user_interrupted"): boolean {
  const run = runs.get(thread_id);
  if (!run || run.status !== "running") return false;
  if (!run.abort.signal.aborted) {
    try { run.abort.abort(reason); } catch { /* */ }
  }
  return true;
}

// Abort every currently-running run. Used by the graceful-shutdown path so
// LangGraph stream loops bail out instead of continuing past process exit.
// Returns the number of runs that were signalled.
export function abortAllRuns(reason = "server_shutdown"): number {
  let count = 0;
  for (const run of runs.values()) {
    if (run.status !== "running") continue;
    if (run.abort.signal.aborted) continue;
    try { run.abort.abort(reason); count++; } catch { /* */ }
  }
  return count;
}

// Poll until every run has transitioned out of "running" (or until the
// caller-supplied deadline elapses). Used during graceful shutdown after
// `abortAllRuns()` so the stream `finally` blocks have a chance to flush
// the trailing error chunk and call `finishRun()`. Resolves to the count
// of runs still stuck in "running" when the deadline hit (0 = clean).
export async function waitForRunsToSettle(timeoutMs: number): Promise<number> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    let stillRunning = 0;
    for (const run of runs.values()) if (run.status === "running") stillRunning++;
    if (stillRunning === 0) return 0;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  let stillRunning = 0;
  for (const run of runs.values()) if (run.status === "running") stillRunning++;
  return stillRunning;
}

// Replays buffered events synchronously, then subscribes for live ones.
// Returns an unsubscribe fn. Caller is responsible for calling it.
export function subscribe(
  thread_id: string,
  onEvent: Subscriber,
): { run: ActiveRun | null; unsubscribe: () => void } {
  const run = runs.get(thread_id);
  if (!run) return { run: null, unsubscribe: () => {} };
  // Replay buffered events first (so the new subscriber catches up).
  for (const ev of run.events) {
    try { onEvent(ev); } catch { /* */ }
  }
  if (run.status !== "running") {
    return { run, unsubscribe: () => {} };
  }
  run.subscribers.add(onEvent);
  return {
    run,
    unsubscribe: () => { run.subscribers.delete(onEvent); },
  };
}
