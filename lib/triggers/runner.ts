import { getOrCreateAgentThread } from "@/lib/stores/threads";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { prepareThreadRun, persistAssistantMessage } from "@/lib/agents/run-thread";
import { collectStream } from "@/lib/agents/stream-collector";
import { getScript } from "./scripts";
import type {
  PromptFiring,
  ScriptFiring,
  TriggerFiring,
  TriggerOutcome,
} from "./types";

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

  // ADR-0061 — silent semantics now live in the system prompt via
  // `buildInboundChannelContext` (category="scheduled_task" / "watcher",
  // `inboundSilent=true`). The body stays as the user-authored prompt so
  // the agent doesn't see two competing copies of the NO_REPLY rule. The
  // post-run NO_REPLY detection on the assistant reply is unchanged.

  try {
    const prepared = await prepareThreadRun({
      thread_id: thread.thread_id,
      message: firing.prompt,
      user_category: category,
      silent: firing.silent === true,
    });
    const collected = await collectStream(prepared.stream);
    const replyText = collected.assistantContent.trim();
    const isNoReply = firing.silent === true && /^\s*NO[_ ]?REPLY\b/i.test(replyText);
    const skipAssistant = firing.silent === true && (isNoReply || replyText.length === 0);
    if (!skipAssistant) {
      persistAssistantMessage(
        thread.thread_id,
        collected.assistantContent,
        collected.usedTools,
        collected.toolEvents,
        category,
        collected.usage ?? null,
        prepared.context_snapshot ?? null,
      );
    }
    return {
      status: skipAssistant ? "skipped" : "done",
      preview: skipAssistant
        ? ""
        : collected.assistantContent.replace(/\s+/g, " ").trim().slice(0, 120),
      threadId: thread.thread_id,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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
    const msg = err instanceof Error ? err.message : String(err);
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
