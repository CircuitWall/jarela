import type { SkillJsonValue } from "@/lib/skills/execution-protocol";
import { getAgentConfig, getAgentToolCredentials } from "@/lib/stores/agent-configs";
import { skillExecutionService } from "@/lib/skills/execution-service";
import { workflowSkillId } from "./authorization";
import { getOrCreateAgentThread } from "@/lib/stores/threads";
import type { WorkflowHostAdapter, WorkflowHostContext, WorkflowExecutionContext } from "./service";
import type { WorkflowStep } from "./definition";

const MODEL_OUTPUT_TOOLS = new Set([
  "delegate_to_agent", "claude_delegate", "claude_delegate_status", "codex_delegate", "codex_delegate_status",
]);
async function permittedTool(agentId: string, action: string, readOnly: boolean) {
  if (["run_workflow", "advance_workflow", "answer_workflow", "cancel_workflow", "reconcile_workflow",
    "run_skill", "cancel_skill_execution", "invoke_tool"].includes(action)) {
    throw new Error("Workflow steps must name a concrete operation, not a coordinator or proxy");
  }
  const { getAllToolCatalogAsync, applyAgentPermissionsToCatalog } = await import("@/lib/tools");
  const agent = getAgentConfig(agentId);
  if (!agent) throw new Error("Workflow agent no longer exists");
  const entry = applyAgentPermissionsToCatalog(await getAllToolCatalogAsync(), agent).find((tool) => tool.name === action);
  if (!entry || entry.permission !== "enabled" || readOnly && entry.capability !== "read") {
    throw new Error("Workflow action is not currently permitted with the declared effect");
  }
  return agent;
}

async function invoke(scope: WorkflowHostContext, action: string, input: SkillJsonValue, signal: AbortSignal, readOnly: boolean, awaitSettlement = false) {
  const { agentId } = scope;
  const agent = await permittedTool(agentId, action, readOnly);
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool input must be an object");
  const { executeTool } = await import("@/lib/tools");
  const result: unknown = await executeTool(action, input, {
    signal, thread_id: getOrCreateAgentThread(agentId).thread_id, tool_credentials: getAgentToolCredentials(agent),
    workspace: { root: scope.workspace, scoped: true },
    await_tool_settlement: awaitSettlement,
  });
  if (result && typeof result === "object" && ("error" in result || "ok" in result && result.ok === false)) {
    throw new Error("Workflow action returned an explicit failure; external effects may require reconciliation");
  }
  const json = JSON.stringify(result);
  if (json === undefined) throw new Error("Workflow action returned no JSON output");
  return json;
}

export function createWorkflowHost(scope: WorkflowHostContext): WorkflowHostAdapter {
  return {
    async execute(step: WorkflowStep, input: SkillJsonValue, signal: AbortSignal, context: WorkflowExecutionContext) {
      if (step.kind === "script") {
        const request = await skillExecutionService().request({
          agentId: scope.agentId, workspace: scope.workspace, skillId: workflowSkillId(step.action),
          inputJson: JSON.stringify(input),
          signal,
          workflow: { runId: scope.runId, revision: context.revision, invocationJson: context.invocationJson, stepId: step.id },
        });
        if (request.status !== "finished" || request.result.status !== "succeeded") return { kind: "unknown" };
        if (signal.aborted) return { kind: "unknown" };
        return { kind: "output", json: JSON.stringify(request.result.output),
          evidence: `Checked skill output and process cleanup; artifact ${request.result.revision}`, origin: "script" };
      }
      try {
        await permittedTool(scope.agentId, step.action, step.effect === "read");
      } catch {
        console.warn("[workflows] tool action not permitted", { runId: scope.runId, stepId: step.id, action: step.action });
        return { kind: "denied" };
      }
      try {
        const json = await invoke(scope, step.action, input, signal, step.effect === "read", true);
        return { kind: "output", json, evidence: `Authorized tool ${step.action} returned JSON; downstream contract checked separately`,
          origin: MODEL_OUTPUT_TOOLS.has(step.action) ? "model_generated" : "tool" };
      } catch {
        console.error("[workflows] tool action failed; external effects may require reconciliation", {
          runId: scope.runId, stepId: step.id, action: step.action, effect: step.effect,
        });
        return { kind: step.effect === "write" ? "unknown" : "retryable" };
      }
    },
    async observe(step, input, signal) {
      if (!step.reconcileAction) throw new Error("No read-back verifier declared; automatic reconciliation is unavailable");
      return {
        outputJson: await invoke(scope, step.reconcileAction, input, signal, true),
        evidence: `Read-back tool ${step.reconcileAction} returned observed output; validated against the write result contract`,
      };
    },
  };
}
