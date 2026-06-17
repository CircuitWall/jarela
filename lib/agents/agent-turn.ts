import type { ContentPart } from "@/lib/tools/types";
import { prepareThreadRun, persistAssistantMessage, snapshotThreadModelConfigName, withInterruptMarker } from "@/lib/agents/run-thread";
import type { AssistantUsageSnapshot } from "@/lib/agents/run-thread";
import { collectStream } from "@/lib/agents/stream-collector";
import { enqueueThreadRun } from "@/lib/agents/run-queue";
import { startRun, finishRun, broadcast } from "@/lib/agents/run-registry";
import { getThread } from "@/lib/stores/threads";
import { resolveTurnProfile, type TurnContextProfile } from "@/lib/agents/turn-profile";
import type { DeliveryChannel } from "@/lib/agents/prepare/request";

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
   * Provenance of the inbound message when delivered through a non-user
   * channel (bridge, trigger, watcher). Forwarded into the system prompt
   * so the agent sees "Delivery channel: WhatsApp ..." and answers in the
   * right register instead of claiming the platform is unavailable.
   */
  delivery_channel?: DeliveryChannel | null;
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

  /**
   * Skip the stall-retry + strict-citation audit wrapper. One-shot
   * callers (browser-extension fill / rewrite) want the raw assistant
   * text without the `↻` separator or pre-retry stall prose that the
   * wrapper would otherwise inject into the streamed content.
   */
  disable_quality_gates?: boolean;
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
  const thread = getThread(req.thread_id);
  const enqueued = enqueueThreadRun(req.thread_id, req.queue_source, async () => {
    // Register in the run-registry like the HTTP route does so the idle
    // and wall-clock watchdogs bound this execution. Without this, a
    // hung provider stream (bad creds, dead upstream, runaway tool loop)
    // from any non-HTTP entry point would pin the per-thread queue head
    // indefinitely. Lives inside the queued callback so registry slots
    // serialise with the queue.
    const active = startRun(req.thread_id, thread?.agent_id ?? null);
    let terminal: "done" | "error" = "error";
    try {
      const prepared = await prepareThreadRun({
        thread_id: req.thread_id,
        message: req.message,
        attachments: req.attachments,
        user_category: req.user_category ?? null,
        delivery_channel: req.delivery_channel ?? null,
        context_profile: contextProfile,
        disable_quality_gates: req.disable_quality_gates,
        signal: active.abort.signal,
        _pinned_model_config_name: pinnedModelConfigName,
        _skip_persist_message: req.skip_persist_user_message,
      });

      const collected = await collectStream(prepared.stream, {
        onChunk: (chunk) => broadcast(active, chunk),
      });
      const trimmed = collected.assistantContent.trim();
      // Silent-mode runners (bridges, watchers, schedulers) skip persistence
      // when the model emitted nothing meaningful — but if the run was
      // user-aborted, we still want a record so the next turn isn't blind to
      // the interruption.
      const skipSilent = req.silent === true
        && !collected.aborted
        && (trimmed.length === 0 || NO_REPLY_RE.test(trimmed));

      if (!skipSilent) {
        const contentToPersist = collected.aborted
          ? withInterruptMarker(collected.assistantContent)
          : collected.assistantContent;
        persistAssistantMessage(
          req.thread_id,
          contentToPersist,
          collected.usedTools,
          collected.toolEvents,
          req.assistant_category ?? req.user_category ?? null,
          collected.usage ?? null,
          prepared.context_snapshot ?? null,
          prepared.source_manifest ?? null,
        );
      }

      terminal = collected.terminal === "error" ? "error" : "done";
      return {
        assistantContent: collected.assistantContent,
        skippedAssistant: skipSilent,
        usage: collected.usage ?? null,
      };
    } finally {
      finishRun(active, terminal);
    }
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
