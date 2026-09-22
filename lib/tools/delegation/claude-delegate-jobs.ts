// In-process job registry for background `claude_delegate` AND
// `codex_delegate` runs — one registry, because "spawn a delegate, poll or
// cancel it by job_id" is the same shape for both providers.
//
// Pinned under globalThis via Symbol.for so the registry survives Next.js
// module re-evaluation (HMR / route-bundle isolation) — same idempotency
// pattern as `workspace-context.ts`'s per-thread state map. Shared between
// `claude-delegate.ts` / `codex-delegate.ts` (writes:
// createJob/appendStep/completeJob/failJob) and their respective
// `*_delegate_status` tools (reads/cancels).
//
// Every job is tagged with the `provider` that created it, and `getJob` /
// `cancelJob` require the caller to state which provider it's acting as —
// a `codex_delegate_status` call (or the codex delegations HTTP route)
// passing a `claude_delegate` job's id gets treated as not-found rather
// than silently reading or killing someone else's job.

import type { ChildProcess } from "node:child_process";

export type JobStatus = "running" | "done" | "error" | "cancelled";
export type JobProvider = "claude" | "codex";

export interface DelegateJob {
  provider: JobProvider;
  status: JobStatus;
  startedAt: number;
  finishedAt: number | null;
  steps: string[];
  result: unknown | null;
  error: string | null;
  projectKey: string;
  sessionId: string;
  parentMessage: string;
  resumed: boolean;
  launch: unknown;
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

export function createJob(jobId: string, opts: { provider: JobProvider; projectKey: string; sessionId: string; parentMessage: string; resumed: boolean; launch?: unknown }): DelegateJob {
  const job: DelegateJob = {
    provider: opts.provider,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    steps: [],
    result: null,
    error: null,
    projectKey: opts.projectKey,
    sessionId: opts.sessionId,
    parentMessage: opts.parentMessage,
    resumed: opts.resumed,
    launch: opts.launch ?? {},
    _child: null,
  };
  registry().set(jobId, job);
  return job;
}

// Scoped by provider so a job_id from one delegate provider can't be read
// through the other's status tool/route.
export function getJob(jobId: string, provider: JobProvider): DelegateJob | null {
  const job = registry().get(jobId);
  return job && job.provider === provider ? job : null;
}

export function appendStep(jobId: string, step: string): void {
  const job = registry().get(jobId);
  if (job && job.status === "running") job.steps.push(step);
}

export function setJobSession(jobId: string, sessionId: string): void {
  const job = registry().get(jobId);
  if (job && job.status === "running") job.sessionId = sessionId;
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

// Scoped by provider for the same reason as `getJob` — a mixed-up job_id
// must not be able to kill a different provider's running process.
export function cancelJob(jobId: string, provider: JobProvider): boolean {
  const job = registry().get(jobId);
  if (!job || job.provider !== provider || job.status !== "running") return false;
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
