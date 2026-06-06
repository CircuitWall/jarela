import type { ContentPart } from "@/lib/tools/types";
import { prepareThreadRun, persistAssistantMessage } from "@/lib/agents/run-thread";
import type { AssistantUsageSnapshot } from "@/lib/agents/run-thread";
import { collectStream } from "@/lib/agents/stream-collector";
import { enqueueThreadRun } from "@/lib/agents/run-queue";

const NO_REPLY_RE = /^\s*NO[_ ]?REPLY\b/i;

export type AgentTurnQueueSource =
  | "user"
  | "scheduler"
  | "watcher"
  | "trigger"
  | "bridge"
  | "delegate";

export interface RunAgentTurnRequest {
  thread_id: string;
  queue_source: AgentTurnQueueSource;
  message: string;
  attachments?: ContentPart[];
  user_category?: string | null;
  assistant_category?: string | null;
  silent?: boolean;
}

export interface RunAgentTurnResult {
  assistantContent: string;
  preview: string;
  skippedAssistant: boolean;
  usage: AssistantUsageSnapshot | null;
}

/**
 * Canonical external-turn runner: queue -> prepare -> collect -> persist.
 *
 * Use this for non-UI callers (bridges, triggers, watchers, schedulers) so
 * they all share the same silent-mode and persistence rules.
 */
export async function runAgentTurn(req: RunAgentTurnRequest): Promise<RunAgentTurnResult> {
  const enqueued = enqueueThreadRun(req.thread_id, req.queue_source, async () => {
    const prepared = await prepareThreadRun({
      thread_id: req.thread_id,
      message: req.message,
      attachments: req.attachments,
      user_category: req.user_category ?? null,
    });

    const collected = await collectStream(prepared.stream);
    const trimmed = collected.assistantContent.trim();
    const skipSilent = req.silent === true && (trimmed.length === 0 || NO_REPLY_RE.test(trimmed));

    if (!skipSilent) {
      persistAssistantMessage(
        req.thread_id,
        collected.assistantContent,
        collected.usedTools,
        collected.toolEvents,
        req.assistant_category ?? req.user_category ?? null,
        collected.usage ?? null,
        prepared.context_snapshot ?? null,
        prepared.source_manifest ?? null,
      );
    }

    return {
      assistantContent: collected.assistantContent,
      skippedAssistant: skipSilent,
      usage: collected.usage ?? null,
    };
  });

  const done = await enqueued.result;
  return {
    assistantContent: done.assistantContent,
    skippedAssistant: done.skippedAssistant,
    usage: done.usage,
    preview: done.skippedAssistant
      ? ""
      : done.assistantContent.replace(/\s+/g, " ").trim().slice(0, 120),
  };
}
