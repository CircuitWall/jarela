import {
  getDueTasks,
  markTaskRan,
  getScheduledTask,
  type ScheduledTaskRow,
} from "@/lib/stores/scheduled-tasks";
import { publish as publishNotification } from "@/lib/notifications/bus";
import type {
  TriggerFiring,
  TriggerHandler,
  TriggerOutcome,
} from "../types";

export const SCHEDULED_TASK_KIND = "scheduled_task";

/**
 * ADR-0032 — produce the right firing for a scheduled task. Routes on
 * `reaction_kind`: 'agent_prompt' → PromptFiring (the original ADR-0021
 * path); 'script' → ScriptFiring dispatched through the trigger runner
 * with no LLM round-trip. Unlike watchers, scheduled-task script firings
 * do NOT carry diff context (`previous`/`current`) — there's no diff to
 * report. Scripts that don't read those fields work in both contexts
 * unchanged.
 */
function buildFiring(task: ScheduledTaskRow): TriggerFiring {
  if (task.reaction_kind === "script" && task.reaction_script) {
    let userArgs: Record<string, unknown> = {};
    if (task.reaction_script_args) {
      try {
        const parsed = JSON.parse(task.reaction_script_args);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          userArgs = parsed as Record<string, unknown>;
        }
      } catch {
        // Persisted args are validated at write time; a parse error here
        // means storage corruption. Fall back to empty.
      }
    }
    return {
      id: task.id,
      kind: SCHEDULED_TASK_KIND,
      mode: "script",
      script: task.reaction_script,
      args: {
        ...userArgs,
        task: {
          id: task.id,
          agent_id: task.agent_id,
          description: task.description,
          schedule: task.schedule,
          schedule_kind: task.kind,
        },
      },
      meta: {
        agent_id: task.agent_id,
        schedule: task.schedule,
        scheduleKind: task.kind,
        reaction_kind: "script",
        reaction_script: task.reaction_script,
        // Carry silent through so markFired can suppress the
        // task_completed notification when the user has muted this task.
        silent: task.silent === 1,
      },
    };
  }
  return {
    id: task.id,
    kind: SCHEDULED_TASK_KIND,
    mode: "prompt",
    agentId: task.agent_id,
    prompt: task.prompt,
    silent: task.silent === 1,
    // Preserves the existing message-channel filter behaviour (ADR-0022).
    category: "scheduled_task",
    meta: { schedule: task.schedule, scheduleKind: task.kind, reaction_kind: "agent_prompt", silent: task.silent === 1 },
  };
}

export const scheduledTaskHandler: TriggerHandler = {
  kind: SCHEDULED_TASK_KIND,

  getDueFirings(asOf: Date): TriggerFiring[] {
    return getDueTasks(asOf).map(buildFiring);
  },

  markFired(firing: TriggerFiring, outcome: TriggerOutcome): void {
    const scheduleKind = (firing.meta?.scheduleKind as ScheduledTaskRow["kind"] | undefined) ?? "cron";
    const schedule = (firing.meta?.schedule as string | undefined) ?? "";
    // Always advance the schedule (or delete the row for one-shots),
    // regardless of which firing mode we ran.
    markTaskRan(firing.id, scheduleKind, schedule, outcome.error);

    // ADR-0032 — silent=true on the task suppresses both NO_REPLY-style
    // agent behaviour AND the task_completed notification. Errors still
    // surface so the user sees failures even on muted tasks.
    const silent = firing.mode === "prompt"
      ? firing.silent === true
      : firing.meta?.silent === true;
    if (silent && !outcome.error) return;

    if (firing.mode === "prompt") {
      publishNotification({
        type: "task_completed",
        task_id: firing.id,
        agent_id: firing.agentId,
        prompt: firing.prompt,
        thread_id: outcome.threadId,
        status: outcome.status,
        preview: outcome.preview,
        error: outcome.error,
        ts: Date.now(),
      });
      return;
    }
    // ADR-0032 — script firings publish a synthesised notification so the
    // UI event stream still lights up. No thread, so threadId is empty.
    const meta = (firing.meta ?? {}) as { agent_id?: string; reaction_script?: string };
    const scriptName = meta.reaction_script ?? firing.script;
    publishNotification({
      type: "task_completed",
      task_id: firing.id,
      agent_id: meta.agent_id ?? "",
      prompt: `Scheduled task fired script ${scriptName}`,
      thread_id: "",
      status: outcome.status === "skipped" ? "done" : outcome.status,
      preview: outcome.preview,
      error: outcome.error,
      ts: Date.now(),
    });
  },
};

/** Public helper for the "Run now" API route — fires a single task by id. */
export function firingForTaskId(taskId: string): TriggerFiring | null {
  const task = getScheduledTask(taskId);
  return task ? buildFiring(task) : null;
}
