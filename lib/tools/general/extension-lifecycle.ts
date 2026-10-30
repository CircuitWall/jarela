import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { getThread } from "@/lib/stores/threads";
import { extensionService, ExtensionCreateInput, ExtensionStageInput } from "@/lib/workflows/extension-service";
import { currentWorkspace } from "../filesystem/workspace-context";
import { registerLangChainPackage } from "../packages/langchain-package";

function agentId(config?: RunnableConfig) {
  const thread = config?.configurable?.thread_id;
  const id = typeof thread === "string" ? getThread(thread)?.agent_id : undefined;
  if (!id) throw new Error("Authoring requires an agent thread");
  return id;
}
async function respond(operation: () => unknown) {
  try { return JSON.stringify(await operation()); }
  catch (error) {
    console.warn("[extension-authoring] operation refused", error instanceof z.ZodError
      ? "Invalid authoring fields" : error instanceof Error ? error.message : "unknown failure");
    return JSON.stringify({ error: error instanceof z.ZodError ? "Invalid authoring fields" : error instanceof Error ? error.message : "Extension operation failed" });
  }
}
export const startExtensionAuthoringTool = tool(async (input, config) => respond(() => {
  const workspace = currentWorkspace(config)?.root;
  if (!workspace) throw new Error("Initialize a workspace first");
  return extensionService().create(agentId(config), workspace, input);
}), {
  name: "start_extension_authoring",
  description: "Capture an inert revision-bound local synthetic-service extension candidate. Discover/reuse existing capabilities first. Optional source replaces only the reviewed CommonJS tool, not its fixed fixture assertions. No files/imports/tests/activation occur. Use request_extension_stage for separately approved staging, full-trust tests, installation, configuration, agent enablement and actual verification. No publication authority.",
  schema: ExtensionCreateInput,
});
export const requestExtensionStageTool = tool(async (input, config) => respond(() => extensionService().request(agentId(config), input)), {
  name: "request_extension_stage",
  description: "Request one exact extension lifecycle stage: stage, test, install, configure, enable, verify, disable, remove, restore or discard. Always pauses for a separate local human approval; pending is not success. Tests use the checked process owner with full host access, NOT a sandbox. Installation copies exact tested code into the configured autoload directory initially disabled; enable separately grants this tool to this agent. Configure accepts only explicit local synthetic fixture_origin. Restore requires retained prior bytes, new staging/tests and new enablement; no automatic rollback. Discard explicitly removes only current inert staged source, not installed code. No trust-policy or package-allowlist escalation.",
  schema: ExtensionStageInput,
});
export const inspectExtensionAuthoringTool = tool(async ({ id }, config) => respond(() => extensionService().inspect(id, agentId(config))), {
  name: "inspect_extension_authoring",
  description: "Inspect this agent's authoring session, observed test/install/verification status and current pending operation. Approval is separate; never infer completion or rollback from a requested stage.",
  schema: z.strictObject({ id: z.uuid() }),
});
registerLangChainPackage({ category: "Config", tools: {
  read: [startExtensionAuthoringTool, inspectExtensionAuthoringTool], execute: [requestExtensionStageTool],
} });
