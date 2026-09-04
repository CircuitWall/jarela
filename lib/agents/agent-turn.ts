import type { ContentPart } from "@/lib/tools/types";
import { prepareThreadRun, persistAssistantMessage, snapshotThreadModelConfigName, withInterruptMarker } from "@/lib/agents/run-thread";
import type { AssistantUsageSnapshot } from "@/lib/agents/run-thread";
import { finalizeRouteDecision } from "@/lib/agents/model-router";
import { collectStream } from "@/lib/agents/stream-collector";
import { enqueueThreadRun, type QueueLane } from "@/lib/agents/run-queue";
import { startRun, finishRun, broadcast } from "@/lib/agents/run-registry";
import { getThread } from "@/lib/stores/threads";
import { resolveTurnProfile, type TurnContextProfile } from "@/lib/agents/turn-profile";
import type { DeliveryChannel } from "@/lib/agents/prepare/request";

// Silent-mode prompts (bridge observer, trigger, page-capture) all instruct
// the model to answer with the literal token "NO_REPLY" (underscore, no
// space), but also explicitly allow prose before it ("if nothing material,
// reply with exactly the single token NO_REPLY"). Anchoring this to the
// start of the string misses that — and it's the compliant path most
// models actually take — so match the sentinel anywhere in the trimmed
// content instead. Require the underscore (or no separator) rather than a
// bare space so this can't fire on ordinary prose like "got no reply yet".
const NO_REPLY_RE = /\bNO_?REPLY\b/i;

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
  user_message_metadata?: Record<string, unknown> | null;
  assistant_message_metadata?: Record<string, unknown> | null;
  history_bridge_key?: string | null;
  silent?: boolean;
  /** Queue policy for callers that distinguish foreground from background work. */
  queue_lane?: QueueLane;
  /** Epoch milliseconds after which this run is too stale to start. */
  queue_expires_at?: number;
  /** Synthetic one-shot prompts can remain visible only through activity rows. */
  persist_user_message?: boolean;
  /** Lifecycle hook used to update an automation activity row. */
  on_queue_state?: (state: "queued" | "running") => void;
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
   * Extra user-role content appended to the in-memory history for this turn
   * only, never persisted. Use it to frame a turn whose prompt is already in
   * the transcript — e.g. the steering continuation, which needs to say "you
   * finished before reading this" without writing another row.
   */
  history_append_message?: string;

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
  aborted: boolean;
}

export class AgentTurnStreamError extends Error {
  readonly code?: string;
  readonly provider?: string;
  readonly credentialId?: string;

  constructor(details: {
    message?: string;
    code?: string;
    provider?: string;
    credentialId?: string;
  }) {
    super(details.message?.trim() || "Agent stream failed");
    this.name = "AgentTurnStreamError";
    this.code = details.code;
    this.provider = details.provider;
    this.credentialId = details.credentialId;
  }
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
    req.on_queue_state?.("running");
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
        message_metadata: req.user_message_metadata ?? null,
        history_bridge_key: req.history_bridge_key ?? null,
        delivery_channel: req.delivery_channel ?? null,
        context_profile: contextProfile,
        disable_quality_gates: req.disable_quality_gates,
        signal: active.abort.signal,
        _pinned_model_config_name: pinnedModelConfigName,
        _skip_persist_message: req.skip_persist_user_message
          ? true
          : req.persist_user_message === false
            ? true
            : undefined,
        _history_append_message: req.history_append_message,
      });

      const startedAt = Date.now();
      const collected = await collectStream(prepared.stream, {
        onChunk: (chunk) => broadcast(active, chunk),
      });
      const routeDecision = finalizeRouteDecision(collected.routeDecision ?? prepared.route_decision ?? null, {
        durationMs: Date.now() - startedAt,
        terminal: collected.terminal,
        errorCode: collected.errorCode,
        retryCount: collected.routeDecision?.retry_count ?? prepared.route_decision?.retry_count ?? 0,
      });
      const trimmed = collected.assistantContent.trim();
      if (collected.terminal === "error" && !collected.aborted) {
        throw new AgentTurnStreamError({
          message: collected.errorMessage,
          code: collected.errorCode,
          provider: collected.errorProvider,
          credentialId: collected.errorCredentialId,
        });
      }
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
          routeDecision,
          req.assistant_message_metadata ?? null,
        );
      }

      terminal = collected.terminal === "error" ? "error" : "done";
      return {
        assistantContent: collected.assistantContent,
        skippedAssistant: skipSilent,
        usage: collected.usage ?? null,
        aborted: collected.aborted === true,
      };
    } finally {
      finishRun(active, terminal);
    }
  }, {
    lane: req.queue_lane,
    expiresAt: req.queue_expires_at,
  });
  if (enqueued.position > 0) req.on_queue_state?.("queued");

  const done = await enqueued.result;
  return {
    assistantContent: done.assistantContent,
    skippedAssistant: done.skippedAssistant,
    usage: done.usage,
    aborted: done.aborted,
    preview: done.skippedAssistant
      ? ""
      : done.assistantContent.replace(/\s+/g, " ").trim().slice(0, 120),
  };
}
