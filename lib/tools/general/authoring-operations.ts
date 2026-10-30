import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { getThread } from "@/lib/stores/threads";
import { AuthoringOperationType, cancelAuthoringOperation, inspectAuthoringOperation } from "@/lib/workflows/authoring-operations";
import { registerLangChainPackage } from "../packages/langchain-package";

const schema = z.strictObject({ id: z.uuid(), type: AuthoringOperationType });
function agentId(config?: RunnableConfig) {
  const thread = config?.configurable?.thread_id;
  const id = typeof thread === "string" ? getThread(thread)?.agent_id : undefined;
  if (!id) throw new Error("Authoring operation requires an agent thread");
  return id;
}
async function respond(operation: () => Promise<unknown>) {
  try { return JSON.stringify(await operation()); }
  catch (error) {
    console.warn("[authoring] operation refused", error instanceof Error ? error.message : "unknown failure");
    return JSON.stringify({ error: "Authoring operation unavailable or refused; inspect actual state before retrying" });
  }
}
export const inspectAuthoringOperationTool = tool(async ({ id, type }, config) => {
  if (type === "contribution") {
    const { inspectContributionOperationTool } = await import("./contribution-lifecycle");
    return inspectContributionOperationTool.invoke({ operation_id: id }, config);
  }
  return respond(async () => {
    const detail = z.object({ stage: z.string(), revision: z.string(), status: z.string(), expires_at: z.string() })
      .parse(await inspectAuthoringOperation(id, type, agentId(config)));
    return { operation_id: id, operation_type: type, stage: detail.stage, revision: detail.revision,
      status: detail.status, expires_at: detail.expires_at,
      review_endpoint: `/api/v1/authoring-operations/${id}?type=${type}` };
  });
}, {
  name: "inspect_authoring_operation",
  description: "Read this agent's extension/contribution operation status and approval metadata. Complete source/diff and observed evidence stay in the local review endpoint, not model output. Pending is not success; unknown effects require read-back, not automatic retry. Does not approve or resume anything.",
  schema,
});
export const cancelAuthoringOperationTool = tool(async ({ id, type }, config) => respond(async () => {
  await cancelAuthoringOperation(id, type, agentId(config));
  return { operation_id: id, operation_type: type, cancellation_requested: true, rollback: false, inspect_required: true };
}), {
  name: "cancel_authoring_operation",
  description: "Request cancellation of this agent's pending/running extension/contribution operation. Acknowledgement is not proof execution stopped. Does not return local source/diffs, undo effects or grant downstream authority. Ownership remains while underlying work settles; inspect actual outcomes instead of replaying writes.",
  schema,
});
registerLangChainPackage({ category: "Config", tools: { read: [inspectAuthoringOperationTool], execute: [cancelAuthoringOperationTool] } });
