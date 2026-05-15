import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  createScheduledTask,
  listScheduledTasks,
  deleteScheduledTask,
  computeNextRun,
} from "@/lib/stores/scheduled-tasks";
import { getThread } from "@/lib/stores/threads";
import { startScheduler } from "@/lib/scheduler";

function agentIdFromConfig(config?: RunnableConfig): string | null {
  const threadId = config?.configurable?.thread_id as string | undefined;
  if (!threadId) return null;
  const thread = getThread(threadId);
  return thread?.agent_id ?? null;
}

export const scheduleTaskTool = tool(
  async ({ prompt, when_iso, cron, description }, config) => {
    const agentId = agentIdFromConfig(config);
    if (!agentId) return JSON.stringify({ error: "No agent context (missing thread_id)" });
    if (!when_iso && !cron) return JSON.stringify({ error: "Provide either when_iso (one-shot) or cron (recurring)" });
    if (when_iso && cron) return JSON.stringify({ error: "Provide only one of when_iso or cron, not both" });

    try {
      const kind = cron ? "cron" : "once";
      const schedule = cron ?? when_iso!;
      // Validate by computing the first run.
      const firstRun = computeNextRun(kind, schedule);
      if (kind === "once" && firstRun.getTime() < Date.now() - 60_000) {
        return JSON.stringify({ error: `when_iso "${schedule}" is in the past` });
      }
      const row = createScheduledTask({ agent_id: agentId, prompt, description, kind, schedule });
      // Make sure the poller is awake so newly created tasks fire on time.
      startScheduler();
      return JSON.stringify({
        ok: true,
        id: row.id,
        next_run_at: row.next_run_at,
        kind,
        schedule,
      });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  {
    name: "schedule_task",
    description:
      "Schedule a prompt to be sent to this agent at a future time. " +
      "For one-shot reminders pass when_iso (ISO 8601 timestamp, e.g. '2026-05-15T15:00:00Z'). " +
      "For recurring tasks pass a 5-field cron expression (e.g. '0 9 * * 1-5' = weekdays 9am). " +
      "Use the current time from your context to convert phrases like 'in 30 minutes' or 'tomorrow at 9am' into when_iso.",
    schema: z.object({
      prompt: z.string().describe("The prompt the agent will receive when the task fires"),
      when_iso: z.string().optional().describe("ISO 8601 UTC timestamp for one-shot scheduling"),
      cron: z.string().optional().describe("5-field cron expression for recurring scheduling"),
      description: z.string().optional().describe("Short human-readable label for the task"),
    }),
  },
);

export const listScheduledTasksTool = tool(
  async (_args, config) => {
    const agentId = agentIdFromConfig(config);
    if (!agentId) return JSON.stringify({ error: "No agent context" });
    const tasks = listScheduledTasks(agentId).map((t) => ({
      id: t.id,
      prompt: t.prompt,
      description: t.description,
      kind: t.kind,
      schedule: t.schedule,
      next_run_at: t.next_run_at,
      last_run_at: t.last_run_at,
      last_error: t.last_error,
      enabled: t.enabled === 1,
    }));
    return JSON.stringify({ tasks, count: tasks.length });
  },
  {
    name: "list_scheduled_tasks",
    description: "List all scheduled tasks for the current agent.",
    schema: z.object({}),
  },
);

export const cancelScheduledTaskTool = tool(
  async ({ id }) => {
    const ok = deleteScheduledTask(id);
    return JSON.stringify(ok ? { ok: true, id } : { error: `Task ${id} not found` });
  },
  {
    name: "cancel_scheduled_task",
    description: "Cancel a previously scheduled task by id.",
    schema: z.object({
      id: z.string().describe("Task id returned by schedule_task or list_scheduled_tasks"),
    }),
  },
);
