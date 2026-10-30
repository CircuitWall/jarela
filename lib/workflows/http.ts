import { z } from "zod";
import { errorResponse } from "@/lib/api/responses";
import { localExecutionGuard } from "@/lib/api/local-execution-guard";

export const WorkflowAgentId = z.string().min(1).max(200);
export const WorkflowCreateBody = z.strictObject({
  agentId: WorkflowAgentId, definitionText: z.string().min(1).max(65536),
  invocationJson: z.string().min(1).max(65536).default("{}"),
  workspace: z.string().min(1).max(4096),
});
const mutation = { agentId: WorkflowAgentId, version: z.number().int().positive() };
export const WorkflowMutationBody = z.discriminatedUnion("action", [
  z.strictObject({ ...mutation, action: z.literal("advance") }),
  z.strictObject({ ...mutation, action: z.literal("cancel") }),
  z.strictObject({ ...mutation, action: z.literal("reconcile") }),
  z.strictObject({
    ...mutation, action: z.literal("answer"),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    stepId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    answerJson: z.string().min(1).max(65536),
  }),
]);
export const WorkflowListQuery = z.strictObject({
  agentId: WorkflowAgentId, limit: z.coerce.number().int().min(1).max(100).default(50),
  after: z.string().uuid().optional(),
});
export const WorkflowItemQuery = z.strictObject({ agentId: WorkflowAgentId });

export const guardWorkflowRequest = localExecutionGuard;

export function workflowError(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return errorResponse("Invalid workflow input", 400);
  if (error instanceof Error && /not found/i.test(error.message)) return errorResponse("Workflow or agent not found", 404);
  if (error instanceof Error && /workspace|definition|binding|schema|invocation|64 KiB|JSON complexity/i.test(error.message)) {
    return errorResponse("Invalid workflow definition, invocation or workspace", 400);
  }
  return errorResponse("Workflow operation refused; inspect the current run before retrying", 409);
}
