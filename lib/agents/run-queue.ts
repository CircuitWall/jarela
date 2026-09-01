// Per-thread priority queue for agent runs.
//
// A thread can have one active run. Waiting interactive runs are selected
// before waiting background runs, while FIFO order is preserved within each
// lane. Different threads drain independently.
//
// In-memory + single-process. Multi-instance deployment would need a shared
// lock (Redis, Postgres advisory locks) — explicitly out of scope.

type Source = "user" | "scheduler" | "watcher" | "trigger" | "bridge" | "extension" | "delegate";

export type QueueLane = "interactive" | "background";

interface QueuedJob<T = unknown> {
  runner: () => Promise<T>;
  expiresAt?: number;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface ThreadQueue {
  active?: QueuedJob;
  interactive: QueuedJob[];
  background: QueuedJob[];
}

const queues = new Map<string, ThreadQueue>();

const DEFAULT_MAX_DEPTH = 16;

const sourceLanes: Record<Source, QueueLane> = {
  user: "interactive",
  bridge: "interactive",
  delegate: "interactive",
  scheduler: "background",
  watcher: "background",
  trigger: "background",
  extension: "background",
};

export interface EnqueueOptions {
  /** Soft cap on per-thread depth, including the active job. Default 16. */
  maxDepth?: number;
  /** Override the source's default queue lane. */
  lane?: QueueLane;
  /** Epoch time in milliseconds after which a waiting job must not start. */
  expiresAt?: number;
}

export interface EnqueueResult<T> {
  /** Promise that resolves when this job's runner completes. */
  result: Promise<T>;
  /** Number of jobs ahead in the current priority ordering at enqueue time. */
  position: number;
}

export class QueueFullError extends Error {
  constructor(thread_id: string, depth: number) {
    super(`Per-thread run queue full for thread ${thread_id} (depth=${depth})`);
    this.name = "QueueFullError";
  }
}

export class QueueExpiredError extends Error {
  constructor(thread_id: string, expiresAt: number) {
    super(`Queued run expired for thread ${thread_id} at ${expiresAt}`);
    this.name = "QueueExpiredError";
  }
}

function depth(queue: ThreadQueue): number {
  return (queue.active ? 1 : 0) + queue.interactive.length + queue.background.length;
}

function drain(thread_id: string, queue: ThreadQueue): void {
  if (queue.active) return;

  const job = queue.interactive.shift() ?? queue.background.shift();
  if (!job) {
    if (queues.get(thread_id) === queue) queues.delete(thread_id);
    return;
  }

  queue.active = job;
  Promise.resolve()
    .then(() => {
      if (job.expiresAt !== undefined && Date.now() >= job.expiresAt) {
        throw new QueueExpiredError(thread_id, job.expiresAt);
      }
      return job.runner();
    })
    .then(
      (value) => {
        finish(thread_id, queue);
        job.resolve(value);
      },
      (error) => {
        finish(thread_id, queue);
        job.reject(error);
      },
    );
}

function finish(thread_id: string, queue: ThreadQueue): void {
  queue.active = undefined;
  if (queues.get(thread_id) === queue) drain(thread_id, queue);
}

export function enqueueThreadRun<T>(
  thread_id: string,
  source: Source,
  runner: () => Promise<T>,
  options: EnqueueOptions = {},
): EnqueueResult<T> {
  const queue = queues.get(thread_id) ?? {
    interactive: [],
    background: [],
  };
  const currentDepth = depth(queue);
  const max = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (currentDepth >= max) {
    throw new QueueFullError(thread_id, currentDepth);
  }

  const lane = options.lane ?? sourceLanes[source];
  const position = queue.active
    ? 1 + queue.interactive.length + (lane === "background" ? queue.background.length : 0)
    : queue.interactive.length + (lane === "background" ? queue.background.length : 0);

  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const result = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const job: QueuedJob<T> = { runner, expiresAt: options.expiresAt, resolve, reject };

  queue[lane].push(job as QueuedJob);
  queues.set(thread_id, queue);
  drain(thread_id, queue);

  return { result, position };
}

/** Current queue depth for a thread, including the active job. */
export function getQueueDepth(thread_id: string): number {
  const queue = queues.get(thread_id);
  return queue ? depth(queue) : 0;
}

/** Reset all queue state. Test-only — never call from production code. */
export function __resetForTests(): void {
  queues.clear();
}
