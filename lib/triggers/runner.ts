import { getOrCreateAgentThread } from "@/lib/stores/threads";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { runAgentTurn } from "@/lib/agents/agent-turn";
import { QueueFullError } from "@/lib/agents/run-queue";
import { getScript } from "./scripts";
import type {
  PromptFiring,
  ScriptFiring,
  TriggerFiring,
  TriggerOutcome,
} from "./types";
import { errorMessage } from "@/lib/utils/error";

/**
 * Invoke an agent for one prompt firing. Extracted from the original
 * scheduler `runTask` so any handler that wants chat semantics goes
 * through the exact same run/persist/silent code path.
 *
 * The runner does NOT publish notifications — different trigger kinds
 * want different notification payloads, so that responsibility stays
 * with each handler's markFired().
 */
export async function runTriggerAgent(firing: PromptFiring): Promise<TriggerOutcome> {
  const agent = getAgentConfig(firing.agentId);
  if (!agent) {
    return {
      status: "error",
      preview: "",
      threadId: "",
      error: `Agent "${firing.agentId}" not found`,
    };
  }
  const thread = getOrCreateAgentThread(firing.agentId);
  const category = firing.category ?? firing.kind;

  // Silent mode: wrap the prompt with a "reply only if material" directive
  // AND a NO_REPLY sentinel so the post-run code can drop the assistant
  // turn entirely when nothing is worth surfacing. Visibility itself is
  // handled at the chat-panel layer via the category-filter toolbar.
  const effectivePrompt = firing.silent
    ? `${firing.prompt}\n\n[SILENT_TRIGGER] This prompt was triggered automatically. Reply with information only if there is something material the user needs to see right now. If nothing material to report, reply with exactly the single token NO_REPLY and nothing else.`
    : firing.prompt;

  try {
    const result = await runAgentTurn({
      thread_id: thread.thread_id,
      queue_source: "trigger",
      message: effectivePrompt,
      user_category: category,
      assistant_category: category,
      silent: firing.silent === true,
    });
    return {
      status: result.skippedAssistant ? "skipped" : "done",
      preview: result.preview,
      threadId: thread.thread_id,
    };
  } catch (err) {
    const msg = err instanceof Error
      ? (err instanceof QueueFullError ? `queue full: ${err.message}` : err.message)
      : String(err);
    return {
      status: "error",
      preview: "",
      threadId: thread.thread_id,
      error: msg,
    };
  }
}

/**
 * Run an in-process script for one script firing. No thread, no LLM,
 * no message persistence — the script does its own side effects. The
 * preview goes into TriggerOutcome for telemetry / notifications.
 */
export async function runTriggerScript(firing: ScriptFiring): Promise<TriggerOutcome> {
  const fn = getScript(firing.script);
  if (!fn) {
    return {
      status: "error",
      preview: "",
      threadId: "",
      error: `Script "${firing.script}" not registered`,
    };
  }
  try {
    const result = await fn(firing.args ?? {});
    return {
      status: "done",
      preview: result.preview,
      threadId: "",
    };
  } catch (err) {
    const msg = errorMessage(err);
    return {
      status: "error",
      preview: "",
      threadId: "",
      error: msg,
    };
  }
}

/**
 * Dispatch one firing by mode. The fan-out loop in runTriggerTick
 * goes through here so handlers don't have to know which runner to
 * call.
 */
export async function runTriggerFiring(firing: TriggerFiring): Promise<TriggerOutcome> {
  if (firing.mode === "script") return runTriggerScript(firing);
  return runTriggerAgent(firing);
}
