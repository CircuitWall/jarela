// Watcher trigger handler (ADR-0027). Sibling of scheduled-task.ts.
//
// Per scheduler tick, for every due watcher row:
//   1. Resolve the named tool from the built-in registry.
//   2. Invoke it with the saved JSON args (no agent context — watcher
//      tools must be context-free).
//   3. Hash the stringified result and compare to last_fingerprint.
//   4. If the hash differs from the previous run, return a TriggerFiring
//      whose prompt embeds a compact previous->current diff for the agent.
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
import { truncateBytes } from "@/lib/utils/text";
import type { TriggerFiring, TriggerHandler, TriggerOutcome } from "../types";
import { errorMessage } from "@/lib/utils/error";

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

const DEFAULT_REACTION_DIRECTIVE =
  `Summarise what changed and decide whether the user needs to know. ` +
  `If nothing material changed, you may stay silent.`;

// Watcher tool outputs can be very large (full JSON payloads, long lists).
// Keep the diff context bounded so one firing cannot consume most of an
// agent's prompt budget.
const MAX_DIFF_CONTEXT_BYTES = 3500;

function normalizeForDiff(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function buildDiffForPrompt(previous: string | null, current: string): string {
  if (previous === null) return "+ (first observation baseline established; no diff available)";

  const prev = normalizeForDiff(previous).split(/\r?\n/);
  const curr = normalizeForDiff(current).split(/\r?\n/);

  let start = 0;
  while (start < prev.length && start < curr.length && prev[start] === curr[start]) {
    start += 1;
  }

  let prevEnd = prev.length - 1;
  let currEnd = curr.length - 1;
  while (prevEnd >= start && currEnd >= start && prev[prevEnd] === curr[currEnd]) {
    prevEnd -= 1;
    currEnd -= 1;
  }

  const removed = prev.slice(start, prevEnd + 1);
  const added = curr.slice(start, currEnd + 1);
  if (removed.length === 0 && added.length === 0) {
    return "(no textual diff after normalization)";
  }

  const hunkHeader = `@@ old:${start + 1}-${Math.max(start, prevEnd + 1)} new:${start + 1}-${Math.max(start, currEnd + 1)} @@`;
  const raw = [
    hunkHeader,
    ...removed.map((l) => `- ${l}`),
    ...added.map((l) => `+ ${l}`),
  ].join("\n");

  const bytes = Buffer.byteLength(raw, "utf8");
  const clipped = truncateBytes(raw, MAX_DIFF_CONTEXT_BYTES);
  if (!clipped.truncated) return raw;
  return `${clipped.text}\n… [diff truncated: showing ${MAX_DIFF_CONTEXT_BYTES} of ${bytes} bytes; full values retained in watcher state]`;
}

function buildFiringPrompt(watcher: WatcherRow, previous: string | null, current: string): string {
  const argsPretty = (() => {
    try { return JSON.stringify(JSON.parse(watcher.tool_args), null, 2); }
    catch { return watcher.tool_args; }
  })();
  // ADR-0030: a non-null reaction_prompt swaps in for the default directive.
  // The diff envelope (label/tool/args/diff) is unchanged so the agent
  // always has the change context regardless of the user's instruction.
  const directive = watcher.reaction_prompt?.trim() || DEFAULT_REACTION_DIRECTIVE;
  return [
    `Watcher "${watcher.label}" detected a change.`,
    ``,
    `Tool: ${watcher.tool_name}`,
    `Args: ${argsPretty}`,
    ``,
    `--- Diff (previous -> current) ---`,
    buildDiffForPrompt(previous, current),
    ``,
    directive,
  ].join("\n");
}

/**
 * ADR-0031 — build the args bundle handed to a `reaction.*` script when
 * a watcher with reaction_kind='script' fires. The bundle merges the
 * user-supplied script args with diff context (previous + current
 * stringified results, plus a slim `watcher` descriptor) so any reaction
 * script can access both the static config and the change context.
 */
function buildScriptArgs(watcher: WatcherRow, previous: string | null, current: string): Record<string, unknown> {
  let userArgs: Record<string, unknown> = {};
  if (watcher.reaction_script_args) {
    try {
      const parsed = JSON.parse(watcher.reaction_script_args);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        userArgs = parsed as Record<string, unknown>;
      }
    } catch {
      // Persisted args are validated at write time; a parse error here
      // means storage corruption. Fall back to empty so the script still
      // runs with diff context.
    }
  }
  return {
    ...userArgs,
    watcher: {
      id: watcher.id,
      label: watcher.label,
      tool_name: watcher.tool_name,
      tool_args: safeJson(watcher.tool_args),
      agent_id: watcher.agent_id,
    },
    previous,
    current,
  };
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * ADR-0031 — produce the right firing for a watcher that just observed
 * a change. Routes on `reaction_kind`: 'agent_prompt' → PromptFiring (the
 * original ADR-0027 path); 'script' → ScriptFiring dispatched through
 * the trigger runner with no LLM round-trip.
 */
function buildFiring(watcher: WatcherRow, previous: string | null, current: string): TriggerFiring {
  if (watcher.reaction_kind === "script" && watcher.reaction_script) {
    return {
      id: watcher.id,
      kind: WATCHER_KIND,
      mode: "script",
      script: watcher.reaction_script,
      args: buildScriptArgs(watcher, previous, current),
      meta: {
        label: watcher.label,
        tool_name: watcher.tool_name,
        agent_id: watcher.agent_id,
        reaction_kind: "script",
        reaction_script: watcher.reaction_script,
        // Carry silent through so markFired can suppress the
        // task_completed notification when the user has muted this watcher.
        silent: watcher.silent === 1,
      },
    };
  }
  return {
    id: watcher.id,
    kind: WATCHER_KIND,
    mode: "prompt",
    agentId: watcher.agent_id,
    prompt: buildFiringPrompt(watcher, previous, current),
    silent: watcher.silent === 1,
    category: "watcher",
    meta: { label: watcher.label, tool_name: watcher.tool_name, reaction_kind: "agent_prompt", silent: watcher.silent === 1 },
  };
}

async function invokeWatcherTool(watcher: WatcherRow): Promise<string> {
  const entry = registeredTools().find((t) => t.name === watcher.tool_name);
  if (!entry) throw new Error(`tool "${watcher.tool_name}" is not registered`);
  let args: unknown;
  try { args = JSON.parse(watcher.tool_args); }
  catch (e) { throw new Error(`tool_args is not valid JSON: ${errorMessage(e)}`); }
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
        firings.push(buildFiring(watcher, watcher.last_result, result));
      }
    } catch (err) {
      const msg = errorMessage(err);
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
    // Polling state (last_run_at, last_fingerprint, last_result,
    // next_run_at) was already advanced inside getDueFirings — we only
    // publish a notification here so the UI's event stream lights up.
    // ADR-0031 — script firings publish too; reuse `task_completed` with
    // a synthesised prompt and the watcher's agent_id from meta (script
    // firings have no thread, so threadId is empty).
    // silent=true on the watcher suppresses the notification (in addition
    // to the prompt-mode NO_REPLY semantic). Errors still surface.
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
    const meta = (firing.meta ?? {}) as { label?: string; agent_id?: string; reaction_script?: string };
    const label = meta.label ?? "(watcher)";
    const scriptName = meta.reaction_script ?? firing.script;
    publishNotification({
      type: "task_completed",
      task_id: firing.id,
      agent_id: meta.agent_id ?? "",
      prompt: `Watcher "${label}" fired script ${scriptName}`,
      thread_id: "",
      status: outcome.status === "skipped" ? "done" : outcome.status,
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
    return buildFiring(watcher, watcher.last_result, result);
  } catch (err) {
    const msg = errorMessage(err);
    recordWatcherPollError(watcher.id, msg);
    throw err;
  }
}
