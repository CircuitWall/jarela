import * as jobs from "./claude-delegate-jobs";

export interface CodexDelegateJobStatus {
  job_id: string;
  status: jobs.JobStatus;
  elapsed_ms: number;
  steps: string[];
  new_steps: string[];
  next_step_index: number;
  project_key: string;
  session_id: string | null;
  resumed: boolean;
  launch: unknown;
  transcript: {
    provider: "Codex";
    parent_message: string;
    steps: string[];
    launch: unknown;
  };
  result?: unknown;
  error?: string | null;
}

export function getCodexDelegateJobStatus(jobId: string, lastStepIndex = 0): CodexDelegateJobStatus | null {
  const job = jobs.getJob(jobId, "codex");
  if (!job) return null;
  const index = Math.max(0, Math.floor(lastStepIndex));
  return {
    job_id: jobId,
    status: job.status,
    elapsed_ms: (job.finishedAt ?? Date.now()) - job.startedAt,
    steps: job.steps,
    new_steps: job.steps.slice(index),
    next_step_index: job.steps.length,
    project_key: job.projectKey,
    session_id: job.sessionId || null,
    resumed: job.resumed,
    launch: job.launch,
    transcript: { provider: "Codex", parent_message: job.parentMessage, steps: job.steps, launch: job.launch },
    ...(job.status === "done" ? { result: job.result } : {}),
    ...(job.status === "error" ? { error: job.error } : {}),
  };
}