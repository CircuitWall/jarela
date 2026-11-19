// `copilot_delegate` / `copilot_delegate_status` — delegate a feature-scoped
// coding task to the GitHub Copilot agent runtime through
// `@microsoft/copilot-sdk` (ADR-0120).
//
// Unlike `claude_delegate` / `codex_delegate`, this provider is not a spawned
// CLI: the SDK owns the runtime process and streams typed events back, so step
// telemetry comes from real event payloads and cancellation is an in-session
// abort rather than a signal to a child process. The runtime is started once
// per process (see copilot-sdk-adapter.ts) and each delegate call owns one
// session; a project/feature keeps its session id so follow-up calls resume
// the same conversation.

import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getIntegrationRaw } from "@/lib/stores/integrations";
import { gitDiffSummary } from "../support/git-probe";
import { registerLangChainPackage } from "../packages/langchain-package";
import { resolveSafetyMode } from "../security/safety";
import { resolveSubprocessEnv } from "../security/subprocess-env";
import { withStreamDefault } from "../support/tool-metadata";
import { currentWorkspace, reportToolProgress, type ToolConfig } from "../filesystem/workspace-context";
import { getCopilotSession, rememberCopilotSession } from "@/lib/stores/copilot-delegate-sessions";
import {
  configureCopilotRuntime, copilotRuntime,
  type CopilotPermissionPrompt, type CopilotSessionHandle,
} from "./copilot-sdk-adapter";
import * as jobs from "./claude-delegate-jobs";
import { getCopilotDelegateJobStatus } from "./copilot-delegate-status";

const INTEGRATION_ID = "github-copilot-cli";
const DEFAULT_TIMEOUT_SECONDS = 600;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function timeoutFrom(value: string | undefined): number | undefined {
  const parsed = Number(clean(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function getCopilotConfig() {
  const saved = getIntegrationRaw(INTEGRATION_ID);
  // Reuse the GitHub integration credential: a fine-grained token with the
  // Copilot Requests permission is the same credential that serves the
  // github_* tools, and asking for a second one just duplicates secrets.
  const github = getIntegrationRaw("github");
  const token = clean(saved?.github_token) ?? clean(github?.token) ?? clean(process.env.COPILOT_GITHUB_TOKEN);
  return {
    runtimePath: clean(saved?.runtime_path) ?? clean(process.env.JARELA_COPILOT_RUNTIME_PATH),
    model: clean(saved?.default_model) ?? clean(process.env.JARELA_COPILOT_DEFAULT_MODEL),
    timeoutSeconds: timeoutFrom(saved?.default_timeout_seconds)
      ?? timeoutFrom(process.env.JARELA_COPILOT_DEFAULT_TIMEOUT_SECONDS) ?? DEFAULT_TIMEOUT_SECONDS,
    baseDirectory: clean(saved?.copilot_home) ?? clean(process.env.COPILOT_HOME),
    token,
  };
}

export function resolveCopilotWorkspace(requestedCwd: string | undefined, workspaceRoot: string | undefined): string | null {
  return requestedCwd?.trim() || workspaceRoot?.trim() || null;
}

function projectKey(cwd: string, feature?: string): string {
  return feature?.trim() ? `${cwd}::${feature.trim()}` : cwd;
}

interface RunSummary {
  result: string;
  sessionId: string | null;
  steps: string[];
  resumed: boolean;
  approvals: { approved: number; rejected: number };
}

function outputShape(summary: RunSummary, opts: {
  task: string;
  cwd: string;
  model?: string;
  safetyMode: ReturnType<typeof resolveSafetyMode>;
  background: boolean;
}) {
  return {
    ok: true,
    result: summary.result || null,
    session_id: summary.sessionId,
    cwd: opts.cwd,
    model: opts.model ?? null,
    permissions: { mode: "approve-once" as const, ...summary.approvals },
    safety_mode: opts.safetyMode,
    resumed: summary.resumed,
    transcript: {
      provider: "Copilot",
      parent_message: opts.task,
      steps: summary.steps,
      launch: { model: opts.model ?? null, background: opts.background },
    },
  };
}

export const copilotDelegateTool = withStreamDefault(tool(
  async ({ task, cwd: requestedCwd, feature, model, timeout_seconds, fresh, background }, config?: ToolConfig) => {
    const safetyMode = resolveSafetyMode();
    if (safetyMode === "safe") {
      return JSON.stringify({ ok: false, code: "SAFETY_BLOCKED", error: "copilot_delegate requires JARELA_TOOL_SAFETY to be at least 'mostly_safe'.", safety_mode: safetyMode });
    }
    const copilot = getCopilotConfig();
    const workspaceRoot = currentWorkspace(config)?.root;
    const requestedWorkspace = resolveCopilotWorkspace(requestedCwd, workspaceRoot);
    if (!requestedWorkspace) {
      return JSON.stringify({
        ok: false,
        code: "WORKSPACE_REQUIRED",
        error: "Copilot delegation requires a project workspace. Call workspace_init with the repository path before delegating, or pass cwd explicitly.",
      });
    }
    // Validated working directory; the runtime itself inherits the app's shell
    // environment when it starts, not per-call additions.
    const { cwd } = resolveSubprocessEnv({ cwd: requestedWorkspace, workspaceRoot });
    const resolvedModel = model ?? copilot.model;
    const key = projectKey(cwd, feature);
    const priorSession = fresh ? null : getCopilotSession(key);
    const timeoutMs = (timeout_seconds ?? copilot.timeoutSeconds) * 1000;
    configureCopilotRuntime({ runtimePath: copilot.runtimePath, token: copilot.token, baseDirectory: copilot.baseDirectory });

    const approvals = { approved: 0, rejected: 0 };
    const onPermission = (prompt: CopilotPermissionPrompt): "approve" | "deny" => {
      // ADR-0087 parity: under mostly_safe/bypass a delegate runs like an
      // interactive user who approves prompts. The decision is still explicit
      // and recorded per request instead of being granted up front.
      approvals.approved += 1;
      void prompt;
      return "approve";
    };

    let active: CopilotSessionHandle | null = null;
    const runTurn = async (onStep: (step: string) => void): Promise<RunSummary> => {
      const runtime = await copilotRuntime();
      const steps: string[] = [];
      const bridge = (step: string) => { steps.push(step); onStep(step); };
      const sessionOptions = {
        model: resolvedModel, workingDirectory: cwd, onPermission, onStep: bridge,
      };
      let session: CopilotSessionHandle | null = null;
      let resumed = false;
      if (priorSession) {
        try {
          session = await runtime.resumeSession(priorSession, sessionOptions);
          resumed = true;
        } catch {
          bridge("↺ previous Copilot session unavailable; started a new one");
        }
      }
      session ??= await runtime.createSession(sessionOptions);
      active = session;
      try {
        const turn = await session.turn({ prompt: task, timeoutMs });
        if (!turn.content && steps.length === 0) {
          throw new Error("Copilot returned no message and reported no activity");
        }
        rememberCopilotSession(key, session.sessionId);
        return { result: turn.content, sessionId: session.sessionId, steps, resumed, approvals: { ...approvals } };
      } finally {
        active = null;
        await session.disconnect();
      }
    };

    const backgroundJobId = background ? randomUUID() : null;
    const backgroundJob = backgroundJobId ? jobs.createJob(backgroundJobId, {
      provider: "copilot", projectKey: key, sessionId: priorSession ?? "", parentMessage: task, resumed: !!priorSession,
      launch: { model: resolvedModel ?? null, background: true },
    }, config) : null;

    if (background && backgroundJobId && backgroundJob) {
      const jobId = backgroundJobId;
      backgroundJob._cancel = () => { void active?.abort(); };
      void runTurn((step) => {
        jobs.appendStep(jobId, step);
        reportToolProgress(config, "copilot_delegate", step);
      })
        .then(async (summary) => {
          if (summary.sessionId) jobs.setJobSession(jobId, summary.sessionId);
          return { ...outputShape(summary, { task, cwd, model: resolvedModel, safetyMode, background: true }), changes: await gitDiffSummary(cwd) };
        })
        .then((result) => jobs.completeJob(jobId, result))
        .catch((error) => jobs.failJob(jobId, (error as Error).message));
      return JSON.stringify({
        job_id: jobId,
        result_key: backgroundJob.resultKey,
        status: "running",
        project_key: key,
        session_id: priorSession,
        resumed: !!priorSession,
        transcript: { provider: "Copilot", parent_message: task, steps: [], launch: backgroundJob.launch },
      });
    }

    const summary = await runTurn((step) => reportToolProgress(config, "copilot_delegate", step));
    return JSON.stringify({
      ...outputShape(summary, { task, cwd, model: resolvedModel, safetyMode, background: false }),
      changes: await gitDiffSummary(cwd),
    });
  },
  {
    name: "copilot_delegate",
    description:
      "Delegate a focused coding task to GitHub Copilot through the Copilot agent runtime (@microsoft/copilot-sdk). Call workspace_init with the target repository before this tool, or pass cwd explicitly; do not use Jarela's install directory as the project workspace. The runtime is the same engine as GitHub Copilot CLI, so the user's Copilot sign-in (copilot login) or a saved fine-grained token authenticates it, and the CLI's own instructions, skills, MCP servers and plugins apply to the delegated run. Under JARELA_TOOL_SAFETY=mostly_safe (default) and 'bypass' each permission request the runtime raises is approved once and recorded in the transcript, matching an interactive user who approves prompts; 'safe' refuses the call outright. Sessions resume per workspace/feature unless fresh is true. Returns Copilot's final message, the per-request approval counts and a git diff summary; inspect the changes before reporting success.",
    schema: z.object({
      task: z.string().min(1).describe("Self-contained coding task for Copilot."),
      cwd: z.string().optional().describe("Target repository directory. Defaults to the active workspace; call workspace_init first when omitted."),
      feature: z.string().optional().describe("Optional sub-session label for parallel work in one workspace."),
      model: z.string().optional().describe("Optional Copilot model override, for example gpt-5.3-codex or claude-sonnet-4.5."),
      fresh: z.boolean().optional().describe("Start a new Copilot session instead of resuming this workspace/feature session."),
      background: z.boolean().optional().describe("Run in the background and return a job id. Agent-owned jobs also return result_key and notify their owner on completion; retrieve encrypted output through tool_result_get."),
      timeout_seconds: z.number().positive().optional().describe("Idle timeout in seconds for the delegated turn."),
    }),
  },
), true);

export const copilotDelegateStatusTool = tool(
  ({ job_id, last_step_index, action }: { job_id: string; last_step_index?: number; action?: "poll" | "cancel" }, config) => {
    const threadId = config?.configurable?.thread_id;
    const ownerThreadId = typeof threadId === "string" ? threadId : undefined;
    const job = jobs.getJobForTool(job_id, "copilot", ownerThreadId);
    if (!job) {
      throw new Error(action === "cancel" ? `No running job with id ${job_id}` : `No job found with id ${job_id}`);
    }
    if (action === "cancel") {
      if (!jobs.cancelJob(job_id, "copilot")) throw new Error(`No running job with id ${job_id}`);
      return JSON.stringify({ job_id, status: "cancelled" });
    }
    if (job.resultKey) return JSON.stringify({
      job_id, status: job.status, result_key: job.resultKey,
      elapsed_ms: (job.finishedAt ?? Date.now()) - job.startedAt, step_count: job.steps.length,
      next_step_index: job.steps.length, steps: [], new_steps: [],
      hint: "Owned delegate output is encrypted. Retrieve terminal output with tool_result_get and result_key; status does not prove business-level success.",
    });
    const status = getCopilotDelegateJobStatus(job_id, last_step_index);
    if (!status) throw new Error(`No job found with id ${job_id}`);
    return JSON.stringify(status);
  },
  {
    name: "copilot_delegate_status",
    description: "Poll or cancel a background copilot_delegate job. Agent-owned jobs return bounded status/step counts and result_key; retrieve encrypted output with tool_result_get. Legacy unowned jobs return steps and results. Cancelling aborts the running Copilot turn and does not undo external effects; inspect changes before reporting business-level success.",
    schema: z.object({
      job_id: z.string().describe("Job id returned by a background copilot_delegate call."),
      last_step_index: z.number().optional().describe("Previous next_step_index; defaults to zero."),
      action: z.enum(["poll", "cancel"]).optional().describe("Poll by default; cancel aborts the running turn."),
    }),
  },
);

registerLangChainPackage({ category: "Other", integrationId: INTEGRATION_ID, tools: { execute: [copilotDelegateTool, copilotDelegateStatusTool] } });
