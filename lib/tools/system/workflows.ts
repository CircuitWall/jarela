import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { getThread } from "@/lib/stores/threads";
import { currentWorkspace } from "../filesystem/workspace-context";
import { registerLangChainPackage } from "../packages/langchain-package";

function agentId(config?: RunnableConfig) {
  const thread = config?.configurable?.thread_id;
  const id = typeof thread === "string" ? getThread(thread)?.agent_id : undefined;
  if (!id) throw new Error("Workflow tool requires an agent thread");
  return id;
}
async function respond(operation: () => Promise<unknown>) {
  try { return JSON.stringify(await operation()); }
  catch (error) { return JSON.stringify({ error: error instanceof Error ? error.message : "Workflow operation failed" }); }
}
export const runWorkflowTool = tool(
  async ({ definition_json, invocation_json }, config) => respond(async () => {
    const workspace = currentWorkspace(config)?.root;
    if (!workspace) throw new Error("Initialize a workspace before creating a workflow");
    const { getWorkflowService } = await import("@/lib/workflows/service");
    const service = getWorkflowService();
    const agent = agentId(config);
    const run = service.create(agent, definition_json, invocation_json, workspace);
    return service.advance(agent, run.id, run.version, config.signal);
  }),
  {
    name: "run_workflow",
    description: "Create and advance a bounded durable workflow with explicit JSON contracts and backward-only bindings. Script steps require a separate exact-plan approval before execution; pending approval is not success. Typed choices pause for the human in Skills workflow controls: never invent answers. Writes run once and uncertain writes require observed reconciliation. No shell-text or code expressions in definitions. Enable every concrete operation separately.",
    schema: z.object({ definition_json: z.string().max(65536), invocation_json: z.string().max(65536).default("{}") }),
  },
);
export const inspectWorkflowTool = tool(
  async ({ id }, config) => respond(async () => {
    const { getWorkflowService } = await import("@/lib/workflows/service");
    return getWorkflowService().inspect(agentId(config), id);
  }),
  {
    name: "inspect_workflow",
    description: "Read this agent's durable workflow status, checked outputs, pending human choice and version. Does not grant script consent or resume execution.",
    schema: z.object({ id: z.uuid() }),
  },
);
export const listWorkflowsTool = tool(
  async (_, config) => respond(async () => {
    const { getWorkflowService } = await import("@/lib/workflows/service");
    return getWorkflowService().list(agentId(config));
  }),
  {
    name: "list_workflows",
    description: "List this agent's retained durable workflow runs. Completed, cancelled and failed runs have bounded retention.",
    schema: z.object({}),
  },
);
function mutation(action: "advance" | "cancel" | "reconcile", name: string, description: string) {
  return tool(async ({ id, version }, config) => respond(async () => {
    const { getWorkflowService } = await import("@/lib/workflows/service");
    const service = getWorkflowService();
    const agent = agentId(config);
    if (action === "cancel") return service.cancel(agent, id, version);
    if (action === "reconcile") return service.reconcile(agent, id, version, config.signal);
    return service.advance(agent, id, version, config.signal);
  }), { name, description, schema: z.object({ id: z.uuid(), version: z.number().int().positive() }) });
}
export const advanceWorkflowTool = mutation("advance", "advance_workflow",
  "Resume this agent's ready workflow using its exact current version. Human script-plan approval and typed answers are separate prerequisites. After restart, interrupted ownership must be proven dead; recovery never blindly replays writes. Inspect the returned phase before continuing.");
export const cancelWorkflowTool = mutation("cancel", "cancel_workflow",
  "Cancel this agent's workflow using its current version. Interrupted writes remain uncertain; cancellation does not roll back external effects.");
export const reconcileWorkflowTool = mutation("reconcile", "reconcile_workflow",
  "Reconcile an uncertain write only through its declared authorized read-back tool. No inferred success or caller-provided output is accepted. Missing read-back support is an explicit blocker, not permission to replay the write.");

registerLangChainPackage({
  category: "Skills",
  tools: {
    read: [inspectWorkflowTool, listWorkflowsTool],
    execute: [runWorkflowTool, advanceWorkflowTool, cancelWorkflowTool, reconcileWorkflowTool],
  },
});
