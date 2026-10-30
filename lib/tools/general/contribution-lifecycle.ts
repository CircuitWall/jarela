import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { getThread } from "@/lib/stores/threads";
import {
  ContributionCreateInput,
  ContributionOperationInput,
  contributionService,
} from "@/lib/workflows/contribution-service";
import { currentWorkspace } from "../filesystem/workspace-context";
import { registerLangChainPackage } from "../packages/langchain-package";

function agentId(config?: RunnableConfig) {
  const threadId = config?.configurable?.thread_id;
  const id = typeof threadId === "string" ? getThread(threadId)?.agent_id : undefined;
  if (!id) throw new Error("Contribution operations require an active agent thread");
  return id;
}

async function respond(operation: () => unknown) {
  try { return JSON.stringify(await operation()); }
  catch (error) {
    return JSON.stringify({
      error: error instanceof z.ZodError
        ? "Invalid contribution fields"
        : error instanceof Error ? error.message : "Contribution operation failed",
    });
  }
}

export const requestContributionTestsTool = tool(async (input, config) => respond(() => {
  const workspace = currentWorkspace(config)?.root;
  if (!workspace) throw new Error("Initialize a workspace first");
  return contributionService().start(agentId(config), workspace, input);
}), {
  name: "request_contribution_tests",
  description: "Capture actual selected repository bytes at an exact clean base and request explicit human approval to run only the listed Vitest files. The local approval preview shows the exact patch and test sources, hooks, environment and full-host-trust effects. Tests run on an isolated topic worktree through Jarela's owned process runner; no caller-reported test claim is accepted. A passing run creates a local review bundle only. It never commits, pushes or opens a PR.",
  schema: ContributionCreateInput,
});

export const requestContributionCommitTool = tool(async ({ operation_id }, config) => respond(async () => {
  const result = await contributionService().requestCommit(operation_id, agentId(config));
  return { ...result, exact_preview_available_locally: true };
}), {
  name: "request_contribution_commit",
  description: "Request a separate local human approval for the exact verified review bundle and commit. The approval preview includes every changed byte, observed test evidence, commit message and identity; configured Git hooks execute normally and are never bypassed. Does not authorize push or draft PR creation.",
  schema: ContributionOperationInput,
});

export const requestContributionPushTool = tool(async ({ operation_id }, config) => respond(async () => {
  const result = await contributionService().requestPush(operation_id, agentId(config));
  return { ...result, exact_preview_available_locally: true };
}), {
  name: "request_contribution_push",
  description: "Request a separate human approval to push only the verified topic ref to origin with a non-forced explicit refspec. Checks local Git credential access first; no main push, force push, remote URL credentials, gh CLI or automatic retry. Configured pre-push hooks run normally. Does not authorize a pull request.",
  schema: ContributionOperationInput,
});

export const requestContributionDraftPrTool = tool(async ({ operation_id }, config) => respond(async () => {
  const result = await contributionService().requestDraftPr(operation_id, agentId(config));
  return { ...result, exact_preview_available_locally: true };
}), {
  name: "request_contribution_draft_pr",
  description: "Request a separate human approval to create one exact GitHub draft PR after the reviewed topic branch is pushed. Uses Jarela's configured GitHub integration only; reports missing credentials and never falls back to gh. No merge or review submission is performed.",
  schema: ContributionOperationInput,
});

export const inspectContributionOperationTool = tool(async ({ operation_id }, config) => respond(() => {
  const operation = contributionService().inspectOperation(operation_id, agentId(config));
  return {
    operation_id: operation.operation_id,
    stage: operation.stage,
    status: operation.status,
    revision: operation.revision,
    proposal_id: operation.proposal_id,
    outcome: operation.outcome,
    expires_at: operation.expires_at,
    publication_authorized: false,
    execution_authorized: false,
  };
}), {
  name: "inspect_contribution_operation",
  description: "Inspect this agent's contribution operation status and current approval identity. The exact code/diff preview is provided only through the local review endpoint, not returned to the model. Pending is not success; unknown outcomes block retry.",
  schema: ContributionOperationInput,
});

registerLangChainPackage({ category: "Config", tools: {
  read: [inspectContributionOperationTool],
  write: [requestContributionCommitTool, requestContributionPushTool, requestContributionDraftPrTool],
  execute: [requestContributionTestsTool],
} });
