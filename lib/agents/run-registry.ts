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
  // Resolves when finishRun() is called for this run. Lets a superseding
  // request (latest-writer-wins arbitration) await the prior run's finally
  // block (persistAssistantMessage + finishRun) before starting its own.
  completion: Promise<void>;
}

const runs = new Map<string, ActiveRun>();
// Resolvers for each run's completion promise. Kept in a side map so the
// ActiveRun shape stays serialisable / inspection-friendly.
const completionResolvers = new WeakMap<ActiveRun, () => void>();

export function startRun(thread_id: string, agent_id: string | null): ActiveRun {
  // If a stale completed run exists, drop it before starting a new one.
  const existing = runs.get(thread_id);
  if (existing && existing.status === "running") {
    throw new Error(`A run is already active for thread ${thread_id}`);
  }
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((res) => { resolveCompletion = res; });
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
    completion,
  };
  completionResolvers.set(run, resolveCompletion);
  runs.set(thread_id, run);
  return run;
}

export function broadcast(run: ActiveRun, chunk: StreamChunk): void {
  // Identity-check: a superseded run (takeOverRun + timeout path) must not
  // smear its trailing chunks onto the replacement entry in the registry.
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
  // Always resolve the completion promise so any takeOverRun() waiter
  // unblocks, even if this run was already superseded.
  completionResolvers.get(run)?.();
  // Identity-check: a superseded run finishing late must not flip the
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

// Latest-writer-wins arbitration. If a run is already in flight for this
// thread (because another tab / device started one), abort it and wait for
// its finally block — persistAssistantMessage + finishRun — to complete,
// then return. Safe (no-op) when no run is active. The caller can then
// proceed to startRun() without tripping the "run already active" guard.
//
// A timeout guards against a stream that refuses to unwind (a hung tool
// invocation that ignores AbortSignal); after the timeout we move on and
// let the new run start. The stale run's eventual finishRun() will then
// be a no-op against the new run because we re-key by thread_id and the
// guard inside finishRun matches on the registry entry, not the old run.
export async function takeOverRun(thread_id: string, timeoutMs = 5000): Promise<void> {
  const cur = runs.get(thread_id);
  if (!cur || cur.status !== "running") return;
  abortRun(thread_id, "superseded");
  await Promise.race([
    cur.completion,
    new Promise<void>((res) => {
      const t = setTimeout(res, timeoutMs);
      t.unref?.();
    }),
  ]);
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
