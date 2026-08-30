import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "./langchain-package";
import { reportToolProgress, type ToolConfig } from "./workspace-context";
import {
  getVersionAdoptionState,
  recordVersionAdoptionWorkflowProgress,
} from "@/lib/stores/version-adoption";
import { errorMessage } from "@/lib/utils/error";

const workflowProgressSchema = z.object({
  workflow_id: z.string().describe("Workflow id. Currently supported: version_adoption."),
  phase: z.string().optional().describe("Optional workflow phase to show in the UI. For version_adoption, use impact_radius, adoption, or complete."),
  item_id: z.string().optional().describe("Optional checklist item id to update."),
  status: z.enum(["pending", "checking", "done", "needs_attention", "skipped"]).optional().describe("Optional checklist item status. Requires item_id."),
  summary: z.string().optional().describe("Optional short workflow summary to persist and show in the UI."),
  detail: z.string().optional().describe("Optional live progress text to stream immediately to the UI."),
  needs_attention_reason: z.string().optional().describe("Optional reason shown when the item or workflow needs user attention."),
});

function versionAdoptionPhase(phase: string | undefined): "impact_radius" | "adoption" | "complete" | undefined {
  return phase === "impact_radius" || phase === "adoption" || phase === "complete"
    ? phase
    : undefined;
}

export const workflowProgressTool = tool(
  async (input, config) => {
    const detail = input.detail?.trim()
      || (input.item_id && input.status ? `${input.item_id}: ${input.status}` : input.phase ? `phase: ${input.phase}` : "workflow progress");
    reportToolProgress(config as ToolConfig | undefined, "workflow_progress", detail);

    if (input.workflow_id !== "version_adoption") {
      return JSON.stringify({
        ok: false,
        workflow_id: input.workflow_id,
        error: `unsupported workflow_id: ${input.workflow_id}`,
      });
    }

    try {
      const result = recordVersionAdoptionWorkflowProgress({
        phase: versionAdoptionPhase(input.phase),
        item_id: input.item_id,
        status: input.status,
        summary: input.summary,
        error: input.needs_attention_reason ?? undefined,
      });
      return JSON.stringify({
        ok: true,
        workflow_id: input.workflow_id,
        state: result.state,
        updated_item_id: result.updated_item_id,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        workflow_id: input.workflow_id,
        error: errorMessage(err),
        state: getVersionAdoptionState(),
      });
    }
  },
  {
    name: "workflow_progress",
    description:
      "Report structured progress for an agent-led multi-step workflow. " +
      "Use this to create or advance a visible checklist: set the workflow phase, mark items checking/done/skipped/needs_attention, and provide short live detail text. " +
      "Currently supported workflow_id: version_adoption.",
    schema: workflowProgressSchema,
  },
);

registerLangChainPackage({
  category: "Agent",
  tools: { write: [workflowProgressTool] },
});