import { getOrCreateAgentThread } from "@/lib/stores/threads";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { prepareThreadRun, persistAssistantMessage } from "@/lib/agents/run-thread";
import { collectStream } from "@/lib/agents/stream-collector";
import type { TriggerFiring, TriggerOutcome } from "./types";

/**
 * Invoke an agent for one trigger firing. Extracted from the original
 * scheduler `runTask` so any handler (cron, tool_call, fs_watch, ...)
 * goes through the exact same run/persist/silent code path.
 *
 * The runner does NOT publish notifications — different trigger kinds
 * want different notification payloads, so that responsibility stays
 * with each handler's markFired().
 */
export async function runTriggerAgent(firing: TriggerFiring): Promise<TriggerOutcome> {
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
    const prepared = await prepareThreadRun(
      thread.thread_id,
      effectivePrompt,
      undefined,
      undefined,
      undefined,
      undefined,
      category,
    );
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
