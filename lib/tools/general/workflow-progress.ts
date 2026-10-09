import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "../packages/langchain-package";
import { reportToolProgress, type ToolConfig } from "../filesystem/workspace-context";
import {
  getVersionAdoptionState,
  recordVersionAdoptionWorkflowProgress,
} from "@/lib/stores/version-adoption";
import { errorMessage } from "@/lib/utils/error";

const workflowItemStatusSchema = z.enum(["pending", "checking", "done", "needs_attention", "skipped"]);

const workflowProgressSchema = z.object({
  workflow_id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
    .describe("Use version_adoption for the system-owned adoption workflow; otherwise use a stable task slug."),
  phase: z.string().max(80).optional().describe("Optional current phase. For version_adoption, use impact_radius, adoption, or complete."),
  items: z.array(z.object({
    id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    label: z.string().min(1).max(120),
    status: workflowItemStatusSchema.optional(),
  })).max(12).optional().describe("For agent-created workflows, send the complete current checklist snapshot on every update. Omitted item statuses default to pending."),
  item_id: z.string().optional().describe("Optional checklist item id to update."),
  status: workflowItemStatusSchema.optional().describe("For version_adoption only: checklist item status. Requires item_id."),
  summary: z.string().max(300).optional().describe("Optional short workflow summary shown in the chat checklist."),
  detail: z.string().max(300).optional().describe("Optional live progress text to stream immediately to the UI."),
  needs_attention_reason: z.string().max(300).optional().describe("Optional reason shown when the item or workflow needs user attention."),
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
      if (!input.items || input.items.length === 0) {
        return JSON.stringify({
          ok: false,
          workflow_id: input.workflow_id,
          error: "Agent-created workflows require the complete current items checklist on every update.",
        });
      }
      if (input.item_id || input.status) {
        return JSON.stringify({
          ok: false,
          workflow_id: input.workflow_id,
          error: "Agent-created workflows update item statuses through the complete items checklist, not item_id/status fields.",
        });
      }
      const itemIds = input.items.map((item) => item.id);
      if (new Set(itemIds).size !== itemIds.length) {
        return JSON.stringify({
          ok: false,
          workflow_id: input.workflow_id,
          error: "Workflow item ids must be unique.",
        });
      }
      const checklist = input.items.map((item) => ({ ...item, status: item.status ?? "pending" as const }));
      if (input.phase === "complete" && checklist.some((item) => item.status !== "done" && item.status !== "skipped")) {
        return JSON.stringify({
          ok: false,
          workflow_id: input.workflow_id,
          error: "A workflow cannot be completed while checklist items remain open or need attention.",
        });
      }
      return JSON.stringify({
        ok: true,
        workflow_id: input.workflow_id,
        state: {
          phase: input.phase ?? null,
          summary: input.summary ?? "",
          error: input.needs_attention_reason ?? null,
          checklist,
        },
        updated_item_id: null,
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
      "Report structured progress for a substantial multi-step task. Use only when the task has several dependent phases, likely spans turns, or needs explicit verification; skip simple tasks and work already covered by native tool progress. For agent-created workflows, send the full current items snapshot on every call and reuse the same workflow_id. Keep secrets and private data out of workflow fields. Mark items done only after verifying the action; use needs_attention for blockers; phase=complete requires every item done or skipped. " +
      "The system-owned version_adoption workflow has its own durable checklist.",
    schema: workflowProgressSchema,
  },
);

registerLangChainPackage({
  category: "Agent",
  tools: { write: [workflowProgressTool] },
});