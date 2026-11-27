import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { listAgentConfigs } from "@/lib/stores/agent-configs";
import { listAutomationActivities } from "@/lib/stores/automation-activity";
import { getThread } from "@/lib/stores/threads";
import { errorMessage } from "@/lib/utils/error";
import { registerLangChainPackage } from "../packages/langchain-package";

const MAX_LABEL_CHARS = 200;

const schema = z.strictObject({
  source_kind: z
    .enum(["scheduled_task", "watcher", "bridge"])
    .optional()
    .describe("Restrict to one automation source kind. Omit for all supported kinds."),
  source_id: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Task or watcher id, as returned by list_scheduled_tasks or list_watchers."),
  disposition: z
    .enum(["action", "no_action", "needs_approval", "failed", "cancelled", "expired"])
    .optional()
    .describe("Restrict to one completed outcome. Use failed to list failures only."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum rows to return, newest first. Default 20."),
});

export const listAutomationActivityTool = tool(
  async ({ source_kind, source_id, disposition, limit }) => {
    try {
      const rows = listAutomationActivities({
        sourceKind: source_kind,
        sourceId: source_id,
        disposition,
        limit,
      });
      const agentNames = new Map(listAgentConfigs().map((agent) => [agent.id, agent.name]));
      const activities = rows.map((row) => {
        const agentId = getThread(row.threadId)?.agent_id ?? null;
        const label = typeof row.activity.label === "string" ? row.activity.label : "";
        return {
          source_kind: row.activity.source_kind,
          source_id: row.activity.source_id,
          label: label.slice(0, MAX_LABEL_CHARS),
          state: row.activity.state,
          disposition: row.activity.disposition ?? null,
          error: typeof row.activity.error === "string" ? row.activity.error : null,
          created_at: row.createdAt,
          last_at:
            typeof row.activity.last_at === "string" ? row.activity.last_at : row.createdAt,
          occurrence_count:
            typeof row.activity.occurrence_count === "number"
              ? row.activity.occurrence_count
              : 1,
          agent_id: agentId,
          agent_name: agentId ? agentNames.get(agentId) ?? null : null,
          thread_id: row.threadId,
        };
      });
      return JSON.stringify({
        activities,
        count: activities.length,
        limit: limit ?? 20,
      });
    } catch (err) {
      return JSON.stringify({ error: errorMessage(err) });
    }
  },
  {
    name: "list_automation_activity",
    description:
      "List recent persisted automation activity for scheduled tasks, watchers, and bridges across all agents. " +
      "Use this to check whether a task or watcher has been failing; list_scheduled_tasks returns only the " +
      "latest error, and a successful run clears it. Newest first, bounded by limit (default 20, max 100). " +
      "Read-only: does not run, cancel, or modify automation. Returns failure text but not the task prompt or " +
      "the agent's output; open thread_id for full context.",
    schema,
  },
);

registerLangChainPackage({
  category: "Schedule",
  tools: { read: [listAutomationActivityTool] },
});
