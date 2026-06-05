// Per-thread FIFO queue for agent runs.
//
// Every entry point that drives an agent on a thread (HTTP POST, scheduler,
// watcher, trigger, bridge) wraps its work with `enqueueThreadRun`. The
// queue serialises execution per `thread_id`: a second job for the same
// thread waits for the first to settle before starting. Different threads
// stay parallel.
//
// Why: a single thread_id is shared across the chat UI, every bridge chat
// routed to the same agent, every watcher fire, and every scheduled task
// for that agent (one-thread-per-agent invariant). LangGraph's SQLite
// checkpoint store is DB-level locked, not per-thread, so two concurrent
// `agent.stream()` calls on the same thread_id will both read the same
// checkpoint, both write, and the later write clobbers the earlier — one
// turn's state can land in another turn's history. Serialising at this
// layer is the cheapest fix.
//
// In-memory + single-process. Multi-instance deployment would need a
// shared lock (Redis, Postgres advisory locks) — explicitly out of scope.
// A process crash drops the in-flight head and discards every queued job
// without ever invoking the runner: same blast radius as today's stranded
// `running` registry entries.

type Source = "user" | "scheduler" | "watcher" | "trigger" | "bridge" | "delegate";

// Per-thread chain tail. Each enqueue chains onto the previous tail; the
// new promise becomes the tail. When the tail settles AND no one chained
// onto it in the meantime, the entry is removed to keep the map bounded.
const tails = new Map<string, Promise<unknown>>();

// Per-thread depth counter. Bumped on enqueue, decremented when the job
// settles. Used for queue_position reporting and the overflow guard.
const depths = new Map<string, number>();

const DEFAULT_MAX_DEPTH = 16;

export interface EnqueueOptions {
  /** Soft cap on per-thread queue depth. Returning above this throws a
   *  `QueueFullError` so the caller can drop the fire instead of pinning
   *  it in memory. Default 16. */
  maxDepth?: number;
}

export interface EnqueueResult<T> {
  /** Promise that resolves when this job's runner completes. Awaiting
   *  this is what blocks bridge/trigger callers until they have the
   *  assistant content to reply / persist. The HTTP route can fire-and-
   *  forget. */
  result: Promise<T>;
  /** 0-indexed slot at enqueue time. 0 means "running now" (no jobs
   *  ahead), N means "waiting behind N jobs". Snapshot only — drains
   *  monotonically as preceding jobs finish but we don't surface
   *  progress updates. */
  position: number;
}

export class QueueFullError extends Error {
  constructor(thread_id: string, depth: number) {
    super(`Per-thread run queue full for thread ${thread_id} (depth=${depth})`);
    this.name = "QueueFullError";
  }
}

export function enqueueThreadRun<T>(
  thread_id: string,
  _source: Source,
  runner: () => Promise<T>,
  options: EnqueueOptions = {},
): EnqueueResult<T> {
  const max = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const currentDepth = depths.get(thread_id) ?? 0;
  if (currentDepth >= max) {
    throw new QueueFullError(thread_id, currentDepth);
  }
  const position = currentDepth;
  depths.set(thread_id, currentDepth + 1);

  // Chain onto the existing tail. Both fulfilled and rejected branches
  // run the new runner — one job's failure must not skip the next.
  const prev = tails.get(thread_id) ?? Promise.resolve();
  const next: Promise<T> = prev.then(() => runner(), () => runner());

  tails.set(thread_id, next);
  // Side-channel cleanup. `.finally` propagates the rejection, so absorb
  // it with a no-op `.catch` — the real rejection is still surfaced to
  // the caller via the returned `result` promise.
  next.finally(() => {
    const d = depths.get(thread_id) ?? 0;
    if (d <= 1) depths.delete(thread_id);
    else depths.set(thread_id, d - 1);
    if (tails.get(thread_id) === next) tails.delete(thread_id);
  }).catch(() => { /* handled by caller via result */ });

  return { result: next, position };
}

/** Current queue depth for a thread, including the running head. 0 means
 *  no in-flight or pending work. Useful for diagnostics and tests. */
export function getQueueDepth(thread_id: string): number {
  return depths.get(thread_id) ?? 0;
}

/** Reset all queue state. Test-only — never call from production code. */
export function __resetForTests(): void {
  tails.clear();
  depths.clear();
}
