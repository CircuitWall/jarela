import * as jobs from "./claude-delegate-jobs";

export interface CopilotDelegateJobStatus {
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
    provider: "Copilot";
    parent_message: string;
    steps: string[];
    launch: unknown;
  };
  result?: unknown;
  error?: string | null;
}

export function getCopilotDelegateJobStatus(jobId: string, lastStepIndex = 0): CopilotDelegateJobStatus | null {
  const job = jobs.getJob(jobId, "copilot");
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
    transcript: { provider: "Copilot", parent_message: job.parentMessage, steps: job.steps, launch: job.launch },
    ...(job.status === "done" ? { result: job.result } : {}),
    ...(job.status === "error" ? { error: job.error } : {}),
  };
}
