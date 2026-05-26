import {
  getDueTasks,
  markTaskRan,
  getScheduledTask,
  type ScheduledTaskRow,
} from "@/lib/stores/scheduled-tasks";
import { publish as publishNotification } from "@/lib/notifications/bus";
import type { TriggerFiring, TriggerHandler, TriggerOutcome } from "../types";

export const SCHEDULED_TASK_KIND = "scheduled_task";

function firingFromTask(task: ScheduledTaskRow): TriggerFiring {
  return {
    id: task.id,
    kind: SCHEDULED_TASK_KIND,
    agentId: task.agent_id,
    prompt: task.prompt,
    silent: task.silent === 1,
    // Preserves the existing message-channel filter behaviour (ADR-0022).
    category: "scheduled_task",
    meta: { schedule: task.schedule, scheduleKind: task.kind },
  };
}

export const scheduledTaskHandler: TriggerHandler = {
  kind: SCHEDULED_TASK_KIND,

  getDueFirings(asOf: Date): TriggerFiring[] {
    return getDueTasks(asOf).map(firingFromTask);
  },

  markFired(firing: TriggerFiring, outcome: TriggerOutcome): void {
    const scheduleKind = (firing.meta?.scheduleKind as ScheduledTaskRow["kind"] | undefined) ?? "cron";
    const schedule = (firing.meta?.schedule as string | undefined) ?? "";
    markTaskRan(firing.id, scheduleKind, schedule, outcome.error);
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
  },
};

/** Public helper for the "Run now" API route — fires a single task by id. */
export function firingForTaskId(taskId: string): TriggerFiring | null {
  const task = getScheduledTask(taskId);
  return task ? firingFromTask(task) : null;
}
