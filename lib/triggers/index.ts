import { listTriggerHandlers, registerTriggerHandler } from "./registry";
import { runTriggerAgent } from "./runner";
import {
  scheduledTaskHandler,
  firingForTaskId,
  SCHEDULED_TASK_KIND,
} from "./handlers/scheduled-task";
import type { TriggerFiring } from "./types";

// Single registration site for built-in handlers. Importing this file
// from the scheduler ensures every handler is wired before the first
// tick. Future PRs add their handlers here (PR-C: tool_call,
// PR-D: fs_watch).
registerTriggerHandler(scheduledTaskHandler);

/** Run one tick of the trigger fan-out. Used by the scheduler loop. */
export async function runTriggerTick(asOf: Date = new Date()): Promise<void> {
  for (const handler of listTriggerHandlers()) {
    let firings: TriggerFiring[];
    try {
      firings = await handler.getDueFirings(asOf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[triggers] handler "${handler.kind}" getDueFirings failed:`, msg);
      continue;
    }
    for (const firing of firings) {
      try {
        const outcome = await runTriggerAgent(firing);
        await handler.markFired(firing, outcome);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[triggers] firing ${handler.kind}/${firing.id} failed:`, msg);
        try {
          await handler.markFired(firing, {
            status: "error",
            preview: "",
            threadId: "",
            error: msg,
          });
        } catch (innerErr) {
          console.error(
            `[triggers] handler "${handler.kind}" markFired threw after error:`,
            innerErr,
          );
        }
      }
    }
  }
}

/**
 * Fire a single scheduled-task by id, on demand. Preserves the original
 * runScheduledTaskNow surface: returns when the run completes, throws
 * the underlying error if the run itself threw.
 */
export async function runScheduledTaskFiringNow(taskId: string): Promise<void> {
  const firing = firingForTaskId(taskId);
  if (!firing) throw new Error(`scheduled task ${taskId} not found`);
  const outcome = await runTriggerAgent(firing);
  await scheduledTaskHandler.markFired(firing, outcome);
  if (outcome.status === "error" && outcome.error) {
    throw new Error(outcome.error);
  }
}

export { SCHEDULED_TASK_KIND };
export * from "./types";
export { registerTriggerHandler, listTriggerHandlers } from "./registry";
export { runTriggerAgent } from "./runner";
