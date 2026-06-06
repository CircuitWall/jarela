import type { ContentPart } from "@/lib/tools/types";
import { prepareThreadRun, persistAssistantMessage, snapshotThreadModelConfigName } from "@/lib/agents/run-thread";
import type { AssistantUsageSnapshot } from "@/lib/agents/run-thread";
import { collectStream } from "@/lib/agents/stream-collector";
import { enqueueThreadRun } from "@/lib/agents/run-queue";
import { resolveTurnProfile, type TurnContextProfile } from "@/lib/agents/turn-profile";

const NO_REPLY_RE = /^\s*NO[_ ]?REPLY\b/i;

export type AgentTurnQueueSource =
  | "user"
  | "scheduler"
  | "watcher"
  | "trigger"
  | "bridge"
  | "extension"
  | "delegate";

export interface RunAgentTurnRequest {
  thread_id: string;
  queue_source: AgentTurnQueueSource;
  message: string;
  attachments?: ContentPart[];
  user_category?: string | null;
  assistant_category?: string | null;
  silent?: boolean;
  /**
   * When true, `prepareThreadRun` will NOT add the message to the DB.
   * Use this when the caller has already persisted the user message and
   * only wants to run the agent against it (e.g. page-capture observer).
   */
  skip_persist_user_message?: boolean;

  /**
   * Per-call override of the context profile (see
   * `@/lib/agents/turn-profile`). When omitted, the profile is resolved
   * from `queue_source` via `TURN_PROFILES`. Provide partial overrides
   * to flip an individual toggle for a specific call without changing
   * the category default.
   */
  context_profile_override?: Partial<TurnContextProfile> | null;
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
  const pinnedModelConfigName = snapshotThreadModelConfigName(req.thread_id);
  const contextProfile = resolveTurnProfile(req.queue_source, req.context_profile_override);
  const enqueued = enqueueThreadRun(req.thread_id, req.queue_source, async () => {
    const prepared = await prepareThreadRun({
      thread_id: req.thread_id,
      message: req.message,
      attachments: req.attachments,
      user_category: req.user_category ?? null,
      context_profile: contextProfile,
      _pinned_model_config_name: pinnedModelConfigName,
      _skip_persist_message: req.skip_persist_user_message,
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
