import { listTriggerHandlers, registerTriggerHandler } from "./registry";
import { runTriggerAgent, runTriggerFiring, runTriggerScript } from "./runner";
import {
  scheduledTaskHandler,
  firingForTaskId,
  SCHEDULED_TASK_KIND,
} from "./handlers/scheduled-task";
import {
  watcherHandler,
  firingForWatcherIdNow,
  WATCHER_KIND,
} from "./handlers/watcher";
import { fsWatchHandler } from "./handlers/fs-watch";
import { documentFastSweepHandler } from "./handlers/document-fast-sweep";
// Side-effect imports: ensure built-in reaction scripts (ADR-0031) are
// in the registry before the first watcher firing dispatches.
import "./reactions/notify";
import type { TriggerFiring } from "./types";
import { errorMessage } from "@/lib/utils/error";

// Single registration site for built-in handlers. Importing this file
// from the scheduler ensures every handler is wired before the first
// tick. Future PRs add their handlers here.
let registered = false;
export function registerHandlers(): void {
  if (registered) return;
  registerTriggerHandler(scheduledTaskHandler);
  registerTriggerHandler(watcherHandler);
  registerTriggerHandler(fsWatchHandler);
  registerTriggerHandler(documentFastSweepHandler);
  registered = true;
}

// Eager registration on module load — preserves the legacy behaviour
// where importing this module wires the scheduled-task handler.
registerHandlers();

/** Boot every registered handler that has a start() lifecycle hook. */
export async function startAllTriggerHandlers(): Promise<void> {
  for (const handler of listTriggerHandlers()) {
    if (!handler.start) continue;
    try {
      await handler.start();
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[triggers] handler "${handler.kind}" start failed:`, msg);
    }
  }
}

/** Drain every registered handler that has a stop() lifecycle hook. */
export async function stopAllTriggerHandlers(): Promise<void> {
  for (const handler of listTriggerHandlers()) {
    if (!handler.stop) continue;
    try {
      await handler.stop();
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[triggers] handler "${handler.kind}" stop failed:`, msg);
    }
  }
}

/**
 * Notify handlers that something they care about changed. Today this
 * is fired by the document-source mutation routes so fs-watch and the
 * fast remote sweep can re-evaluate which sources they're watching.
 */
export async function notifyTriggerHandlers(_reason: string): Promise<void> {
  for (const handler of listTriggerHandlers()) {
    if (!handler.sync) continue;
    try {
      await handler.sync();
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[triggers] handler "${handler.kind}" sync failed:`, msg);
    }
  }
}

/** Run one tick of the trigger fan-out. Used by the scheduler loop. */
export async function runTriggerTick(asOf: Date = new Date()): Promise<void> {
  for (const handler of listTriggerHandlers()) {
    let firings: TriggerFiring[];
    try {
      firings = await handler.getDueFirings(asOf);
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[triggers] handler "${handler.kind}" getDueFirings failed:`, msg);
      continue;
    }
    for (const firing of firings) {
      try {
        const outcome = await runTriggerFiring(firing);
        await handler.markFired(firing, outcome);
      } catch (err) {
        const msg = errorMessage(err);
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
  const storedFiring = firingForTaskId(taskId);
  if (!storedFiring) throw new Error(`scheduled task ${taskId} not found`);
  // "Run now" is an explicit user action, so a cron occurrence that became
  // stale while queued by the scheduler must not expire this manual run.
  const firing: TriggerFiring = {
    ...storedFiring,
    meta: {
      ...Object.fromEntries(Object.entries(storedFiring.meta ?? {}).filter(([key]) => key !== "expiresAt")),
      queueLane: "interactive",
    },
  };
  // Route through runTriggerFiring so script-kind firings dispatch
  // through the script registry instead of the agent (ADR-0032).
  const outcome = await runTriggerFiring(firing);
  await scheduledTaskHandler.markFired(firing, outcome);
  if (outcome.status === "error" && outcome.error) {
    throw new Error(outcome.error);
  }
}

/**
 * Force a single watcher to poll right now. If the polled value differs
 * from the previously stored fingerprint, fire the agent and return.
 * Returns silently when there's no diff (so the manual "Run now" button
 * doesn't fabricate a turn out of an unchanged poll).
 */
export async function runWatcherFiringNow(watcherId: string): Promise<void> {
  const storedFiring = await firingForWatcherIdNow(watcherId);
  if (!storedFiring) return;
  if (storedFiring.mode !== "prompt") return;
  const firing = {
    ...storedFiring,
    meta: {
      ...Object.fromEntries(Object.entries(storedFiring.meta ?? {}).filter(([key]) => key !== "expiresAt")),
      queueLane: "interactive",
    },
  };
  const outcome = await runTriggerAgent(firing);
  await watcherHandler.markFired(firing, outcome);
  if (outcome.status === "error" && outcome.error) {
    throw new Error(outcome.error);
  }
}

export { SCHEDULED_TASK_KIND, WATCHER_KIND };
export * from "./types";
export { registerTriggerHandler, listTriggerHandlers } from "./registry";
export { runTriggerAgent, runTriggerScript, runTriggerFiring };
export {
  registerScript,
  getScript,
  listScripts,
  listReactionScripts,
  isReactionScript,
  REACTION_SCRIPT_PREFIX,
} from "./scripts";
