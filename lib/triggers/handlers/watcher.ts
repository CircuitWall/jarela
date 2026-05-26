// Watcher trigger handler (ADR-0027). Sibling of scheduled-task.ts.
//
// Per scheduler tick, for every due watcher row:
//   1. Resolve the named tool from the built-in registry.
//   2. Invoke it with the saved JSON args (no agent context — watcher
//      tools must be context-free).
//   3. Hash the stringified result and compare to last_fingerprint.
//   4. If the hash differs from the previous run, return a TriggerFiring
//      whose prompt embeds {previous, current} as context for the agent.
//      If it matches (or this is the first run with no previous), record
//      the fingerprint and skip — no LLM call, no firing.
//   5. Either way the watcher's next_run_at is advanced by
//      interval_seconds. Errors during polling are recorded on the row
//      and surfaced in the UI.
//
// All scheduling work happens inside `getDueFirings` because the
// abstraction's markFired is only called for actually-fired runs.
import { createHash } from "node:crypto";
import {
  getDueWatchers,
  getWatcher,
  recordWatcherPoll,
  recordWatcherPollError,
  type WatcherRow,
} from "@/lib/stores/watchers";
import { registeredTools } from "@/lib/tools/registry";
import { publish as publishNotification } from "@/lib/notifications/bus";
import type { TriggerFiring, TriggerHandler, TriggerOutcome } from "../types";

export const WATCHER_KIND = "watcher";

function fingerprint(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function stringifyResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildFiringPrompt(watcher: WatcherRow, previous: string | null, current: string): string {
  const argsPretty = (() => {
    try { return JSON.stringify(JSON.parse(watcher.tool_args), null, 2); }
    catch { return watcher.tool_args; }
  })();
  return [
    `Watcher "${watcher.label}" detected a change.`,
    ``,
    `Tool: ${watcher.tool_name}`,
    `Args: ${argsPretty}`,
    ``,
    `--- Previous result ---`,
    previous ?? "(none — first observation)",
    ``,
    `--- Current result ---`,
    current,
    ``,
    `Summarise what changed and decide whether the user needs to know. ` +
    `If nothing material changed, you may stay silent.`,
  ].join("\n");
}

async function invokeWatcherTool(watcher: WatcherRow): Promise<string> {
  const entry = registeredTools().find((t) => t.name === watcher.tool_name);
  if (!entry) throw new Error(`tool "${watcher.tool_name}" is not registered`);
  let args: unknown;
  try { args = JSON.parse(watcher.tool_args); }
  catch (e) { throw new Error(`tool_args is not valid JSON: ${e instanceof Error ? e.message : String(e)}`); }
  // LangChain tools accept the args object directly via .invoke().
  // Watcher tools must be context-free (no thread_id / agent_id).
  const result = await entry.invoke(args as Record<string, unknown>);
  return stringifyResult(result);
}

/**
 * Poll every due watcher and produce firings only for those whose
 * tool result changed since the last poll. Updates polling state
 * synchronously so subsequent ticks see the advanced next_run_at.
 */
async function pollDueWatchers(asOf: Date): Promise<TriggerFiring[]> {
  const due = getDueWatchers(asOf);
  const firings: TriggerFiring[] = [];
  for (const watcher of due) {
    try {
      const result = await invokeWatcherTool(watcher);
      const fp = fingerprint(result);
      const firstRun = watcher.last_fingerprint === null;
      const changed = !firstRun && fp !== watcher.last_fingerprint;
      recordWatcherPoll({
        id: watcher.id,
        fingerprint: fp,
        result,
        fired: changed,
      });
      if (changed) {
        firings.push({
          id: watcher.id,
          kind: WATCHER_KIND,
          mode: "prompt",
          agentId: watcher.agent_id,
          prompt: buildFiringPrompt(watcher, watcher.last_result, result),
          silent: watcher.silent === 1,
          category: "watcher",
          meta: { label: watcher.label, tool_name: watcher.tool_name },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordWatcherPollError(watcher.id, msg);
      // A polling error doesn't fire the agent; it's surfaced via
      // last_error on the row + UI. Logging only.
      console.error(`[watcher] poll ${watcher.id} (${watcher.tool_name}) failed:`, msg);
    }
  }
  return firings;
}

export const watcherHandler: TriggerHandler = {
  kind: WATCHER_KIND,

  async getDueFirings(asOf: Date): Promise<TriggerFiring[]> {
    return pollDueWatchers(asOf);
  },

  markFired(firing: TriggerFiring, outcome: TriggerOutcome): void {
    if (firing.mode !== "prompt") return;
    // Polling state (last_run_at, last_fingerprint, last_result,
    // next_run_at) was already advanced inside getDueFirings — we only
    // publish a notification here so the UI's event stream lights up.
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

/**
 * "Run now" — force a single poll of one watcher and, if the result
 * differs from `last_fingerprint`, return a ready-to-run firing. Used by
 * the manual /run HTTP endpoint. Returns null when the poll didn't
 * trigger a firing (no change, or the watcher is gone).
 */
export async function firingForWatcherIdNow(id: string): Promise<TriggerFiring | null> {
  const watcher = getWatcher(id);
  if (!watcher) return null;
  try {
    const result = await invokeWatcherTool(watcher);
    const fp = fingerprint(result);
    const firstRun = watcher.last_fingerprint === null;
    const changed = !firstRun && fp !== watcher.last_fingerprint;
    recordWatcherPoll({ id: watcher.id, fingerprint: fp, result, fired: changed });
    if (!changed) return null;
    return {
      id: watcher.id,
      kind: WATCHER_KIND,
      mode: "prompt",
      agentId: watcher.agent_id,
      prompt: buildFiringPrompt(watcher, watcher.last_result, result),
      silent: watcher.silent === 1,
      category: "watcher",
      meta: { label: watcher.label, tool_name: watcher.tool_name },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordWatcherPollError(watcher.id, msg);
    throw err;
  }
}
