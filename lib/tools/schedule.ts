import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import { registerTools } from "./registry";
import {
  createScheduledTask,
  listScheduledTasks,
  deleteScheduledTask,
  computeNextRun,
} from "@/lib/stores/scheduled-tasks";
import { getThread } from "@/lib/stores/threads";
import { startScheduler } from "@/lib/scheduler";

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function agentIdFromConfig(config?: RunnableConfig): string | null {
  const threadId = config?.configurable?.thread_id as string | undefined;
  if (!threadId) return null;
  const thread = getThread(threadId);
  return thread?.agent_id ?? null;
}

export const scheduleTaskTool = tool(
  async (
    { prompt, when_iso, cron, description, silent, reaction_kind, reaction_script, reaction_script_args },
    config,
  ) => {
    const agentId = agentIdFromConfig(config);
    if (!agentId) return JSON.stringify({ error: "No agent context (missing thread_id)" });
    if (!when_iso && !cron) return JSON.stringify({ error: "Provide either when_iso (one-shot) or cron (recurring)" });
    if (when_iso && cron) return JSON.stringify({ error: "Provide only one of when_iso or cron, not both" });
    // ADR-0032 — for kind='script' the agent must supply reaction_script.
    // For kind='agent_prompt' (default) prompt is required.
    if (reaction_kind === "script") {
      if (!reaction_script) {
        return JSON.stringify({ error: "reaction_kind='script' requires reaction_script" });
      }
    } else if (!prompt) {
      return JSON.stringify({ error: "prompt is required when reaction_kind='agent_prompt'" });
    }

    try {
      const kind = cron ? "cron" : "once";
      const schedule = cron ?? when_iso!;
      // Validate by computing the first run.
      const firstRun = computeNextRun(kind, schedule);
      if (kind === "once" && firstRun.getTime() < Date.now() - 60_000) {
        return JSON.stringify({ error: `when_iso "${schedule}" is in the past` });
      }
      const row = createScheduledTask({
        agent_id: agentId,
        prompt,
        description,
        kind,
        schedule,
        silent,
        reaction_kind,
        reaction_script,
        reaction_script_args,
      });
      // Make sure the poller is awake so newly created tasks fire on time.
      startScheduler();
      return JSON.stringify({
        ok: true,
        id: row.id,
        next_run_at: row.next_run_at,
        kind,
        schedule,
        silent: row.silent === 1,
        reaction_kind: row.reaction_kind,
        reaction_script: row.reaction_script,
      });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  {
    name: "schedule_task",
    description:
      "Schedule a future firing for this agent. " +
      "For one-shot reminders pass when_iso (ISO 8601 timestamp, e.g. '2026-05-15T15:00:00Z'). " +
      "For recurring tasks pass a 5-field cron expression (e.g. '0 9 * * 1-5' = weekdays 9am). " +
      "Use the current time from your context to convert phrases like 'in 30 minutes' or 'tomorrow at 9am' into when_iso. " +
      "Default reaction_kind is 'agent_prompt' — the firing sends `prompt` to the agent. " +
      "Set reaction_kind='script' to fire a registered reaction.* script with no LLM round-trip; " +
      "use list_reaction_scripts to discover names. " +
      "Set silent=true for background polling tasks: suppresses the task_completed notification AND instructs the " +
      "agent to answer NO_REPLY on firings where there is nothing material to surface (those turns are dropped). " +
      "Errors still notify so failures aren't hidden. Visible firings remain tagged 'scheduled' so the user can hide " +
      "the group with the chat filter toolbar.",
    schema: z.object({
      prompt: z.string().optional().describe(
        "The prompt the agent will receive when the task fires. Required when reaction_kind='agent_prompt' (the default).",
      ),
      when_iso: z.string().optional().describe("ISO 8601 UTC timestamp for one-shot scheduling"),
      cron: z.string().optional().describe("5-field cron expression for recurring scheduling"),
      description: z.string().optional().describe("Short human-readable label for the task"),
      silent: z.boolean().optional().describe(
        "When true the task is muted: the task_completed notification is suppressed and the agent is instructed to " +
        "reply only when something material surfaces (NO_REPLY answers are dropped). Errors still notify. " +
        "Useful for background polling jobs (e.g. 'check inbox every 10 min').",
      ),
      reaction_kind: z.enum(["agent_prompt", "script"]).optional().describe(
        "ADR-0032 reaction discriminator. 'agent_prompt' (default) runs the agent with `prompt`. " +
        "'script' runs a registered reaction.* script with no LLM round-trip.",
      ),
      reaction_script: z.string().optional().describe(
        "Required when reaction_kind='script'. Must be a name returned by list_reaction_scripts (begins with 'reaction.').",
      ),
      reaction_script_args: z.record(z.string(), z.unknown()).optional().describe(
        "Optional JSON object of args forwarded to the reaction script. The script also receives a `task` descriptor.",
      ),
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
      silent: t.silent === 1,
      reaction_kind: t.reaction_kind,
      reaction_script: t.reaction_script,
      reaction_script_args: t.reaction_script_args ? safeJson(t.reaction_script_args) : null,
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

registerTools("Schedule", [scheduleTaskTool, listScheduledTasksTool, cancelScheduledTaskTool]);
