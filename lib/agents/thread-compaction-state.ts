import { getConfig } from "@/lib/env/config";
import { getOrCreateGlobal } from "@/lib/utils/global-state";

// Every compaction is bound to its thread: one attempt per kind per thread,
// held in process-global state so each route bundle sees the same attempts
// (the compact route and the thread GET route must agree on "compacting"),
// and bounded by a deadline so a stalled provider can't leave a thread
// "compacting" until the next restart.

export type CompactionKind = "manual" | "auto" | "refresh";

export interface CompactionAttempt {
  readonly threadId: string;
  readonly kind: CompactionKind;
  readonly boundarySeq: number | null;
  readonly startedAt: number;
  readonly deadlineAt: number;
  /** False once the attempt timed out or was replaced; it must not commit. */
  isCurrent(): boolean;
}

export class CompactionTimeoutError extends Error {
  constructor(threadId: string, kind: CompactionKind, timeoutMs: number) {
    super(`${kind} compaction for thread ${threadId} timed out after ${timeoutMs} ms`);
    this.name = "CompactionTimeoutError";
  }
}

const attempts = getOrCreateGlobal(
  "__jarela_thread_compaction_attempts",
  () => new Map<string, Map<CompactionKind, CompactionAttempt>>(),
);

function slotFor(threadId: string): Map<CompactionKind, CompactionAttempt> {
  let slot = attempts.get(threadId);
  if (!slot) { slot = new Map(); attempts.set(threadId, slot); }
  return slot;
}

function release(attempt: CompactionAttempt): void {
  const slot = attempts.get(attempt.threadId);
  if (slot?.get(attempt.kind) !== attempt) return;
  slot.delete(attempt.kind);
  if (slot.size === 0) attempts.delete(attempt.threadId);
}

export function getCompactionAttempt(threadId: string, kind: CompactionKind): CompactionAttempt | null {
  return attempts.get(threadId)?.get(kind) ?? null;
}

export function isCompactionRunning(threadId: string, kind?: CompactionKind): boolean {
  const slot = attempts.get(threadId);
  if (!slot) return false;
  return kind ? slot.has(kind) : slot.size > 0;
}

const KIND_PRIORITY: readonly CompactionKind[] = ["manual", "auto", "refresh"];

/** The most significant compaction running on the thread, if any. */
export function currentCompaction(threadId: string): CompactionAttempt | null {
  const slot = attempts.get(threadId);
  if (!slot) return null;
  for (const kind of KIND_PRIORITY) {
    const attempt = slot.get(kind);
    if (attempt) return attempt;
  }
  return null;
}

/**
 * Register a compaction on the thread synchronously, run it, and release it
 * when it settles or its deadline passes. On timeout the attempt stops being
 * current — pass it to compactThreadWarmContext so a late result is dropped
 * instead of committed — and the promise rejects with CompactionTimeoutError.
 * A newer attempt of the same kind replaces (and invalidates) an older one.
 */
export function runTrackedCompaction<T>(
  threadId: string,
  kind: CompactionKind,
  boundarySeq: number | null,
  run: (attempt: CompactionAttempt) => Promise<T>,
  timeoutMs: number = getConfig().compactionTimeoutMs,
): Promise<T> {
  const startedAt = Date.now();
  let current = true;
  const attempt: CompactionAttempt = {
    threadId,
    kind,
    boundarySeq,
    startedAt,
    deadlineAt: startedAt + timeoutMs,
    isCurrent: () => current && attempts.get(threadId)?.get(kind) === attempt,
  };
  slotFor(threadId).set(kind, attempt);

  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      current = false;
      release(attempt);
      reject(new CompactionTimeoutError(threadId, kind, timeoutMs));
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });

  let work: Promise<T>;
  try {
    work = run(attempt);
  } catch (err) {
    work = Promise.reject(err);
  }
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
    current = false;
    release(attempt);
  });
}

export function __resetCompactionAttemptsForTests(): void {
  attempts.clear();
}
