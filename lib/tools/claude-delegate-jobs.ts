// In-process job registry for background `claude_delegate` runs.
//
// Pinned under globalThis via Symbol.for so the registry survives Next.js
// module re-evaluation (HMR / route-bundle isolation) — same idempotency
// pattern as `workspace-context.ts`'s per-thread state map. Shared between
// `claude-delegate.ts` (writes: createJob/appendStep/completeJob/failJob)
// and its `claude_delegate_status` tool (reads/cancels).

import type { ChildProcess } from "node:child_process";

export type JobStatus = "running" | "done" | "error" | "cancelled";

export interface DelegateJob {
  status: JobStatus;
  startedAt: number;
  finishedAt: number | null;
  steps: string[];
  result: unknown | null;
  error: string | null;
  projectKey: string;
  sessionId: string;
  _child: ChildProcess | null;
}

const JOBS_SYM: unique symbol = Symbol.for("@jarela/claude-delegate-jobs");
type GlobalWithJobs = typeof globalThis & {
  [JOBS_SYM]?: Map<string, DelegateJob>;
};

function registry(): Map<string, DelegateJob> {
  const g = globalThis as GlobalWithJobs;
  if (!g[JOBS_SYM]) g[JOBS_SYM] = new Map();
  return g[JOBS_SYM];
}

export function createJob(jobId: string, opts: { projectKey: string; sessionId: string }): DelegateJob {
  const job: DelegateJob = {
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    steps: [],
    result: null,
    error: null,
    projectKey: opts.projectKey,
    sessionId: opts.sessionId,
    _child: null,
  };
  registry().set(jobId, job);
  return job;
}

export function getJob(jobId: string): DelegateJob | null {
  return registry().get(jobId) ?? null;
}

export function appendStep(jobId: string, step: string): void {
  const job = registry().get(jobId);
  if (job && job.status === "running") job.steps.push(step);
}

// completeJob/failJob only transition a job that's still "running" — a
// cancelled job's underlying process can still emit a late close/error
// event after cancelJob already flipped the status; without this guard
// that late event would silently overwrite "cancelled" with "done"/"error".
export function completeJob(jobId: string, result: unknown): void {
  const job = registry().get(jobId);
  if (!job || job.status !== "running") return;
  job.status = "done";
  job.finishedAt = Date.now();
  job.result = result;
  job._child = null;
}

export function failJob(jobId: string, errorMessage: string): void {
  const job = registry().get(jobId);
  if (!job || job.status !== "running") return;
  job.status = "error";
  job.finishedAt = Date.now();
  job.error = errorMessage;
  job._child = null;
}

export function cancelJob(jobId: string): boolean {
  const job = registry().get(jobId);
  if (!job) return false;
  if (job._child) {
    try { job._child.kill("SIGTERM"); } catch { /* already dead */ }
  }
  job.status = "cancelled";
  job.finishedAt = Date.now();
  job._child = null;
  return true;
}

// Test-only: wipe the registry between test files/runs.
export function _resetDelegateJobs(): void {
  registry().clear();
}
