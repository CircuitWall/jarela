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
  };
  runs.set(thread_id, run);
  return run;
}

export function broadcast(thread_id: string, chunk: StreamChunk): void {
  const run = runs.get(thread_id);
  if (!run) return;
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

export function finishRun(thread_id: string, status: "done" | "error"): void {
  const run = runs.get(thread_id);
  if (!run) return;
  run.status = status;
  run.finished_at = Date.now();
  // Drop subscribers — late attachers should NOT keep getting events on a
  // dead run. They'll get the buffered events on subscribe and that's it.
  run.subscribers.clear();
  // Auto-evict after TTL so memory doesn't grow with every conversation.
  setTimeout(() => {
    const cur = runs.get(thread_id);
    if (cur === run) runs.delete(thread_id);
  }, RECENT_TTL_MS).unref?.();
}

export function getRun(thread_id: string): ActiveRun | null {
  return runs.get(thread_id) ?? null;
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
