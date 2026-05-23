import type { StreamChunk } from "./base";

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

const MAX_BUFFERED = 4000;        // text_delta chunks accumulate fast; cap them
const RECENT_TTL_MS = 5 * 60_000; // keep finished runs visible for 5 min

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
}

const runs = new Map<string, ActiveRun>();

export function startRun(thread_id: string, agent_id: string | null): ActiveRun {
  // If a stale completed run exists, drop it before starting a new one.
  const existing = runs.get(thread_id);
  if (existing && existing.status === "running") {
    throw new Error(`A run is already active for thread ${thread_id}`);
  }
  const run: ActiveRun = {
    thread_id,
    agent_id,
    started_at: Date.now(),
    finished_at: null,
    status: "running",
    events: [],
    subscribers: new Set(),
    final_text: "",
    abort: new AbortController(),
  };
  runs.set(thread_id, run);
  return run;
}

export function broadcast(run: ActiveRun, chunk: StreamChunk): void {
  // Identity-check: a superseded run must not smear trailing chunks onto
  // the replacement entry in the registry.
  if (runs.get(run.thread_id) !== run) return;
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
