/**
 * @public — `POST /api/v1/threads/[thread_id]/run` (submit run),
 *           `GET /api/v1/threads/[thread_id]/run` (subscribe via SSE)
 *
 * Agent execution endpoint. Submit a run, then stream tokens, tool
 * calls, and final state. The split-and-subscribe shape lets reconnects
 * pick up an in-flight stream. See `docs/api.md`.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { StreamOptions, StreamChunk } from "@/lib/agents/base";
import type { ContentPart } from "@/lib/tools/runtime/types";
import {
  prepareThreadRun,
  persistThreadRunUserMessage,
  persistAssistantMessage,
  withInterruptMarker,
  RunThreadError,
  snapshotThreadModelConfigName,
  shouldEmitChunk,
} from "@/lib/agents/run-thread";
import { broadcast, finishRun, startRun, subscribe, abortRun, pushSteering, drainSteering, getRun, waitForRun } from "@/lib/agents/run-registry";
import { runAgentTurn } from "@/lib/agents/agent-turn";
import { enqueueThreadRun, QueueFullError, getQueueDepth } from "@/lib/agents/run-queue";
import { collectStream } from "@/lib/agents/stream-collector";
import { getThread, getThreadMessageBySeq, isValidThreadContextCursor, addMessage, updateMessageContent } from "@/lib/stores/threads";
import { publish as publishNotification } from "@/lib/notifications/bus";
import { sseResponse } from "@/lib/api/sse";
import { validateBody, errorJson } from "@/lib/api/responses";
import { resolveTurnProfile } from "@/lib/agents/turn-profile";
import type { RouteDecisionMetadata } from "@/api/types";
import { finalizeRouteDecision } from "@/lib/agents/model-router";
import { getConfig } from "@/lib/env/config";
import { parseToolResultReferenceEnvelope } from "@/lib/tools/support/result-refs";
import { safeTranscriptFailureReason } from "@/api/message-content";
import { createAssistantTranscriptDraft, persistAssistantDraftChunk, type AssistantTranscriptDraft } from "@/lib/agents/transcript-draft";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

type Params = { params: Promise<{ thread_id: string }> };

const enc = new TextEncoder();
const sse = (obj: Record<string, unknown>, eventId?: string) =>
  enc.encode(`${eventId ? `id: ${eventId}\n` : ""}data: ${JSON.stringify(obj)}\n\n`);

// Persist a `run_error` marker row so a failed turn survives reload and
// cross-device sync even when no assistant content was produced. The row
// is filtered out of the LLM history window (see getRecentMessagesWindow)
// and rendered as a compact chip by the chat UI. See ADR-0069.
interface RunErrorSource {
  errorMessage?: string;
  errorCode?: string;
  errorCredentialId?: string;
  errorProvider?: string;
  routeDecision?: RouteDecisionMetadata | null;
}

function estimateUtf8Bytes(text: string): number {
  return enc.encode(text).byteLength;
}

function estimatePayloadBytes(payload: unknown): number {
  try {
    return estimateUtf8Bytes(JSON.stringify(payload));
  } catch {
    return 0;
  }
}

function spilledToolResultBytes(payload: unknown): number {
  return parseToolResultReferenceEnvelope(payload)?.bytes ?? 0;
}

function persistRunErrorMarker(thread_id: string, src: RunErrorSource): void {
  const raw = (src.errorMessage ?? "").trim();
  const message = raw.length > 0 ? raw : "run failed";
  // Cap the persisted body so a stack trace can't bloat the row.
  const truncated = message.length > 2048 ? message.slice(0, 2045) + "…" : message;
  const metadata: Record<string, unknown> = {
    kind: "run_error",
    code: src.errorCode ?? "run_crashed",
  };
  if (src.errorCredentialId) metadata.credential_id = src.errorCredentialId;
  if (src.errorProvider) metadata.provider = src.errorProvider;
  if (src.routeDecision) metadata.routing = src.routeDecision;
  try {
    addMessage(thread_id, "assistant", truncated, null, "run_error", metadata, "failed", safeTranscriptFailureReason(src.errorCode));
  } catch (err) {
    console.error("[run] failed to persist run_error marker", err);
  }
}

// `attachments` and `stream_options` are passed through to prepareThreadRun
// which does its own structural handling — keep loose at this boundary.
const RunBody = z.object({
  message: z.string(),
  attachments: z.array(z.unknown()).optional(),
  stream_options: z.unknown().optional(),
  message_metadata: z.strictObject({ hidden_from_chat: z.boolean() }).optional(),
  // ADR-0096 — exact first-hot message seq; null clears the pin.
  hot_since_seq: z.number().int().positive().nullable().optional(),
  // ADR-0044 — automation channels the chat panel's filter toolbar has
  // toggled on for this turn (scheduled_task/watcher/bridge). "chat" is
  // unioned in server-side regardless of what the client sends, so callers
  // don't have to remember to include it. Omitted = today's chat-only scope.
  channels: z.array(z.string()).optional(),
});

// POST is the *command* half of the run lifecycle (ADR-0008). It accepts the
// new user message, registers a run in the in-memory registry, kicks the
// agent loop off in a detached async task, and returns 202 after the user
// transcript is durable. The
// caller must follow up with a GET on this same path (as an `EventSource`)
// to subscribe to the chunk stream — see GET below.
//
// Splitting submit from subscribe gives us a single reliable streaming
// primitive across all browsers (EventSource is the only WebKit-native
// streaming API that survives iOS Safari + Tailscale HTTP/2 proxies). It
// also collapses what was previously a WS sidecar + SSE-over-POST +
// SSE-GET-reattach trio into one transport.
export async function POST(req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  const parsed = await validateBody(req, RunBody);
  if (parsed instanceof NextResponse) return parsed;
  const message = parsed.message;
  const attachments = parsed.attachments as ContentPart[] | undefined;
  const stream_options = parsed.stream_options as StreamOptions | undefined;
  if (typeof parsed.hot_since_seq === "number" && !isValidThreadContextCursor(thread_id, parsed.hot_since_seq)) {
    return errorJson({ error: "Boundary seq does not belong to this thread", code: "invalid_boundary" }, { status: 400 });
  }
  const hot_since_seq = parsed.hot_since_seq;
  const channels = parsed.channels ? Array.from(new Set(["chat", ...parsed.channels])) : undefined;

  // Per-thread priority queue (lib/agents/run-queue.ts). Every entry point
  // that drives an agent on a thread goes through this — HTTP POST,
  // scheduler, watcher, trigger, bridge — so concurrent fires on the same
  // thread_id serialises instead of racing the LangGraph checkpoint store;
  // interactive work runs before waiting background work without preemption.
  // If the queue is already at the soft cap, reject with 503 so the
  // caller can back off rather than pin yet more work in memory.
  const thread = getThread(thread_id);
  if (!thread) {
    return errorJson({ error: NOT_FOUND_ERRORS.THREAD, code: "thread_not_found" }, { status: 404 });
  }
  const pinnedModelConfigName = snapshotThreadModelConfigName(thread_id);
  const contextProfile = resolveTurnProfile("user");
  const enqueuedAt = Date.now();
  let position: number;
  let releaseAdmission!: (persisted: boolean) => void;
  const admission = new Promise<boolean>((resolve) => { releaseAdmission = resolve; });
  let persistedTurn: Awaited<ReturnType<typeof persistThreadRunUserMessage>> | null = null;
  const assistantDraftState: { current: AssistantTranscriptDraft | null } = { current: null };
  const submitted: SubmittedTurn = {
    thread_id, message, stream_options, hot_since_seq, channels, thread,
    pinnedModelConfigName, contextProfile, enqueuedAt,
  };
  try {
    ({ position } = enqueueThreadRun(thread_id, "user", async () => {
      if (!(await admission)) return;
      const admittedTurn = persistedTurn;
      if (!admittedTurn) return;
      await executeSubmittedTurn(submitted, assistantDraftState, admittedTurn);
    }));
  } catch (err) {
    if (err instanceof QueueFullError) {
      return new Response(
        JSON.stringify({ accepted: false, code: "queue_full", thread_id, error: err.message }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    throw err;
  }

  try {
    persistedTurn = await persistThreadRunUserMessage({
      thread_id,
      message,
      attachments,
      message_metadata: parsed.message_metadata,
      context_profile: contextProfile,
      _onTranscriptUserPersisted: () => {
        assistantDraftState.current = createAssistantTranscriptDraft(thread_id);
      },
    });
    releaseAdmission(true);
  } catch (err) {
    releaseAdmission(false);
    if (err instanceof RunThreadError) {
      return errorJson({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("[run] failed to persist submitted user message", err);
    return errorJson({ error: "Failed to persist submitted user message", code: "transcript_persist_failed" }, { status: 500 });
  }

  return new Response(
    JSON.stringify({ accepted: true, thread_id, queue_position: position }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
}

interface SubmittedTurn {
  thread_id: string;
  message: string;
  stream_options?: StreamOptions;
  hot_since_seq?: number | null;
  channels?: string[];
  thread: NonNullable<ReturnType<typeof getThread>>;
  pinnedModelConfigName: string | null;
  contextProfile: ReturnType<typeof resolveTurnProfile>;
  enqueuedAt: number;
}

type DraftState = { current: AssistantTranscriptDraft | null };
type AdmittedTurn = Awaited<ReturnType<typeof persistThreadRunUserMessage>>;

async function executeSubmittedTurn(
  submitted: SubmittedTurn,
  assistantDraftState: DraftState,
  admittedTurn: AdmittedTurn,
): Promise<void> {
  const {
    thread_id, message, stream_options, hot_since_seq, channels, thread,
    pinnedModelConfigName, contextProfile,
  } = submitted;
  // Registry slots serialize with queue execution, not HTTP admission.
  const active = startRun(thread_id, thread?.agent_id ?? null);
  broadcast(active, { type: "status", data: { phase: "starting", label: "Starting…" } });
  const runStartedAt = Date.now();
  const perfTelemetryEnabled = getConfig().perfTelemetryEnabled;
  let prepDurationMs = 0;
  let prepared;
  try {
    const activatedUserMessage = updateMessageContent(
      admittedTurn.userMessageId,
      admittedTurn.storedContent,
      { transcriptStatus: "completed" },
    );
    if (!activatedUserMessage) throw new Error("Submitted user message no longer exists");
    broadcast(active, { type: "status", data: { phase: "preparing", label: "Preparing context…" } });
    const prepStartedAt = Date.now();
    prepared = await prepareThreadRun({
      thread_id,
      message,
      options: stream_options,
      attachments: admittedTurn.attachments,
      signal: active.abort.signal,
      hot_since_seq,
      channels,
      context_profile: contextProfile,
      _pinned_model_config_name: pinnedModelConfigName,
      _onCompacting: () => broadcast(active, {
        type: "status", data: { phase: "compacting", label: "Compacting earlier messages…" },
      }),
      _user_message_persisted: true,
      _idle_ms_before_user: admittedTurn.idleMsBefore,
    });
    prepDurationMs = Date.now() - prepStartedAt;
  } catch (err) {
    // Admission already returned 202; buffer the failure for SSE reattachment.
    const message_ = err instanceof RunThreadError ? err.message : String(err);
    const code = err instanceof RunThreadError ? err.code : "run_prepare_error";
    broadcast(active, { type: "error", data: { message: message_, code } });
    const draft = assistantDraftState.current;
    if (draft) {
      updateMessageContent(draft.msg_id, draft.visibleContent, {
        category: "run_error",
        transcriptStatus: "failed",
        statusReason: safeTranscriptFailureReason(code),
      });
    } else {
      persistRunErrorMarker(thread_id, { errorMessage: message_, errorCode: code });
    }
    finishRun(active, "error");
    return;
  }
  await collectSubmittedTurn(
    submitted, active, prepared, assistantDraftState,
    runStartedAt, prepDurationMs, perfTelemetryEnabled,
  );
}

async function collectSubmittedTurn(
  submitted: SubmittedTurn,
  active: ReturnType<typeof startRun>,
  prepared: Awaited<ReturnType<typeof prepareThreadRun>>,
  assistantDraftState: DraftState,
  runStartedAt: number,
  prepDurationMs: number,
  perfTelemetryEnabled: boolean,
): Promise<void> {
  const { thread_id, thread, enqueuedAt } = submitted;
  const queueWaitMs = Math.max(0, runStartedAt - enqueuedAt);
  let ttftMs: number | null = null;
  let streamDurationMs = 0;
  const toolsUsed = new Set<string>();
  let terminal: "done" | "error" = "error";
  let assistantContent = "";
  let terminalErrorCode: string | undefined;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let cacheCreateTokens: number | null = null;
  let thinkingTokens: number | null = null;
  let toolResultCount = 0;
  let toolResultBytes = 0;
  let toolResultBytesSpilled = 0;
  // Execution outlives subscribers; settlement must always release the registry.
  try {
    const startedAt = Date.now();
    broadcast(active, { type: "status", data: { phase: "thinking", label: "Thinking…" } });
    const streamStartedAt = Date.now();
    const collected = await collectStream(prepared.stream as AsyncIterable<StreamChunk>, {
      onChunk: (chunk) => {
        if (ttftMs === null && chunk.type !== "heartbeat") {
          ttftMs = Math.max(0, Date.now() - runStartedAt);
        }
        if (chunk.type === "tool_call") {
          const toolName = chunk.data && typeof chunk.data.name === "string"
            ? chunk.data.name
            : "";
          if (toolName) toolsUsed.add(toolName);
        }
        const draft = assistantDraftState.current;
        if (draft) persistAssistantDraftChunk(draft, chunk);
        broadcast(active, chunk);
      },
    });
    streamDurationMs = Date.now() - streamStartedAt;
    assistantContent = collected.assistantContent;
    terminal = collected.terminal;
    terminalErrorCode = collected.errorCode;
    if (collected.usage) {
      inputTokens = collected.usage.input_tokens;
      outputTokens = collected.usage.output_tokens;
      cacheReadTokens = collected.usage.cache_read_input_tokens ?? 0;
      cacheCreateTokens = collected.usage.cache_creation_input_tokens ?? 0;
      thinkingTokens = collected.usage.thinking_tokens ?? null;
    }
    if (collected.toolEvents?.length) {
      const resultEvents = collected.toolEvents.filter((ev) => ev.phase === "result");
      toolResultCount = resultEvents.length;
      toolResultBytes = resultEvents.reduce((sum, ev) => sum + estimatePayloadBytes(ev.payload), 0);
      toolResultBytesSpilled = resultEvents.reduce((sum, ev) => sum + spilledToolResultBytes(ev.payload), 0);
    }
    const routeDecision = finalizeRouteDecision(collected.routeDecision ?? prepared.route_decision ?? null, {
      durationMs: Date.now() - startedAt,
      terminal: collected.terminal,
      errorCode: collected.errorCode,
      retryCount: collected.routeDecision?.retry_count ?? prepared.route_decision?.retry_count ?? 0,
    });
    // collectStream can catch a thrown iterator without an error event; don't
    // mask a deliberate abort with the synthetic stream_error event.
    if (collected.terminal === "error" && collected.errorMessage && !collected.aborted) {
      broadcast(active, {
        type: "error",
        data: { message: collected.errorMessage, code: "stream_error" },
      });
    }
    try {
      persistSubmittedResult(thread_id, prepared, collected, assistantDraftState, routeDecision);
    } catch (persistErr) {
      terminal = "error";
      const draft = assistantDraftState.current;
      if (draft && getThreadMessageBySeq(thread_id, draft.seq)?.transcript_status === "in_progress") {
        updateMessageContent(draft.msg_id, draft.visibleContent, {
          transcriptStatus: "failed",
          statusReason: safeTranscriptFailureReason("persist_error"),
        });
      }
      broadcast(active, {
        type: "error",
        data: { message: `persist failed: ${(persistErr as Error).message}`, code: "persist_error" },
      });
    }
  } catch (err) {
    terminal = "error";
    const errMsg = (err as Error).message ?? String(err);
    broadcast(active, { type: "error", data: { message: errMsg, code: "run_crashed" } });
    try {
      const draft = assistantDraftState.current;
      if (draft && getThreadMessageBySeq(thread_id, draft.seq)?.transcript_status === "in_progress") {
        updateMessageContent(draft.msg_id, draft.visibleContent, {
          category: draft.visibleContent ? null : "run_error",
          transcriptStatus: "failed",
          statusReason: safeTranscriptFailureReason("run_crashed"),
        });
      } else if (!draft) {
        persistRunErrorMarker(thread_id, {
          errorMessage: errMsg, errorCode: "run_crashed", routeDecision: prepared.route_decision ?? null,
        });
      }
    } catch (persistErr) {
      console.error("[run] failed to persist run_error marker", persistErr);
    }
  } finally {
    if (perfTelemetryEnabled) logRunPerformance({
      thread_id, terminal, runStartedAt, ttftMs, toolsUsed, assistantContent,
      inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens,
      queueWaitMs, prepDurationMs, streamDurationMs, thinkingTokens,
      toolResultCount, toolResultBytes, toolResultBytesSpilled, terminalErrorCode,
    });
    finishRun(active, terminal);
    publishNotification({
      type: "run_completed",
      thread_id,
      agent_id: thread?.agent_id ?? null,
      status: terminal,
      preview: assistantContent.replace(/\s+/g, " ").trim().slice(0, 120),
      ts: Date.now(),
    });
  }
}

interface RunPerformance {
  thread_id: string;
  terminal: "done" | "error";
  runStartedAt: number;
  ttftMs: number | null;
  toolsUsed: Set<string>;
  assistantContent: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreateTokens: number | null;
  queueWaitMs: number;
  prepDurationMs: number;
  streamDurationMs: number;
  thinkingTokens: number | null;
  toolResultCount: number;
  toolResultBytes: number;
  toolResultBytesSpilled: number;
  terminalErrorCode?: string;
}

function logRunPerformance(metrics: RunPerformance): void {
  const { thread_id, terminal, runStartedAt, ttftMs, toolsUsed, assistantContent,
    inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, queueWaitMs,
    prepDurationMs, streamDurationMs, thinkingTokens, toolResultCount,
    toolResultBytes, toolResultBytesSpilled, terminalErrorCode } = metrics;
  const totalMs = Math.max(0, Date.now() - runStartedAt);
  const ttftValue = ttftMs ?? totalMs;
  const toolList = Array.from(toolsUsed).join(",") || "none";
  const assistantChars = assistantContent.length;
  const assistantBytes = estimateUtf8Bytes(assistantContent);
  const inTok = inputTokens ?? -1;
  const outTok = outputTokens ?? -1;
  const cacheRead = cacheReadTokens ?? -1;
  const cacheCreate = cacheCreateTokens ?? -1;
  const cacheDenom = Math.max(0, inTok) + Math.max(0, cacheRead) + Math.max(0, cacheCreate);
  const cacheReadPct = cacheDenom > 0 && cacheRead >= 0
    ? Math.round((cacheRead / cacheDenom) * 1000) / 10
    : -1;
  console.info(
    `[perf.run] thread=${thread_id} status=${terminal}`
    + ` queue_ms=${queueWaitMs}`
    + ` prep_ms=${prepDurationMs}`
    + ` ttft_ms=${ttftValue}`
    + ` stream_ms=${streamDurationMs}`
    + ` total_ms=${totalMs}`
    + ` input_tokens=${inTok}`
    + ` output_tokens=${outTok}`
    + ` cache_read_tokens=${cacheRead}`
    + ` cache_create_tokens=${cacheCreate}`
    + ` cache_read_pct=${cacheReadPct}`
    + ` thinking_tokens=${thinkingTokens ?? -1}`
    + ` assistant_chars=${assistantChars}`
    + ` assistant_bytes=${assistantBytes}`
    + ` tool_results=${toolResultCount}`
    + ` tool_result_bytes=${toolResultBytes}`
    + ` tool_result_bytes_spilled=${toolResultBytesSpilled}`
    + ` tools=${toolList}`
    + ` error_code=${terminalErrorCode ?? "-"}`,
  );
}

function persistSubmittedResult(
  thread_id: string,
  prepared: Awaited<ReturnType<typeof prepareThreadRun>>,
  collected: Awaited<ReturnType<typeof collectStream>>,
  assistantDraftState: DraftState,
  routeDecision: RouteDecisionMetadata | null,
): void {
  const contentToPersist = collected.aborted
    ? withInterruptMarker(collected.assistantContent)
    : collected.assistantContent;
  const noResponse = collected.terminal === "done"
    && !collected.aborted
    && !contentToPersist.trim()
    && !collected.toolEvents.length
    && !prepared.signal_delivery?.signals.length;
  const transcriptStatus = collected.aborted
    ? "interrupted"
    : collected.terminal === "done" && !noResponse ? "completed" : "failed";
  const statusReason = transcriptStatus === "interrupted"
    ? "Stopped by user."
    : noResponse ? "The model completed without producing a response."
    : transcriptStatus === "failed" ? safeTranscriptFailureReason(collected.errorCode) : null;
  const draft = assistantDraftState.current;
  persistAssistantMessage(
    thread_id,
    contentToPersist,
    collected.usedTools,
    collected.toolEvents,
    null,
    collected.usage ?? null,
    prepared.context_snapshot ?? null,
    prepared.source_manifest ?? null,
    routeDecision,
    prepared.memory_recall ? { memory_recall: prepared.memory_recall } : null,
    collected.terminal === "done" && !collected.aborted ? prepared.signal_delivery : undefined,
    draft ? { draftMessageId: draft.msg_id, transcriptStatus, statusReason } : undefined,
  );
  if (
    collected.terminal === "error"
    && !collected.aborted
    && !collected.assistantContent.trim()
    && (!collected.toolEvents || collected.toolEvents.length === 0)
    && !assistantDraftState.current
  ) {
    persistRunErrorMarker(thread_id, { ...collected, routeDecision });
  }
  // Steering arriving during the final model call needs a queued continuation.
  if (!collected.aborted) {
    const undelivered = drainSteering(thread_id);
    if (undelivered.length > 0) {
      void runAgentTurn({
        thread_id,
        queue_source: "user",
        message: undelivered.join("\n\n"),
        skip_persist_user_message: true,
        history_append_message: STEERING_CONTINUATION_PREFIX + undelivered.join("\n\n"),
      }).catch((err) => console.error("[run] steering continuation failed", err));
    }
  }
}

// GET is the *query* half of the run lifecycle (ADR-0008). Attaches to an
// active (or recently-finished, within the registry TTL) run and streams
// chunks as Server-Sent Events. Always consumed client-side via
// `EventSource` — never `fetch().body.getReader()`, which is unreliable on
// iOS Safari for long-lived streaming responses.
//
// Emits a single synthetic `done` event and closes when there's no run to
// attach to (run never existed, or it finished + TTL-evicted before the GET
// arrived). We deliberately do NOT return 404 here: browsers map a 404 SSE
// response onto `EventSource.onerror` with no terminal event, which trips
// EventSource's auto-reconnect logic and leaves the client in a "stream
// open but silent" state — UIs gating on a `done` event hang forever
// showing the Stop/Reconnecting affordances. A 200 with `data: {"type":
// "done"}\n\n` makes the iterator drain cleanly on every transport.
//
// `show_tools` / `show_thinking` query params let the caller suppress
// chunk types it doesn't want to render. Defaults: both on. The full
// `StreamOptions` shape is only meaningful on the POST (tool policy &
// agent run config are run-wide settings, not per-subscriber filters).
export async function GET(req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  const showTools = req.nextUrl.searchParams.get("show_tools") !== "false";
  const showThinking = req.nextUrl.searchParams.get("show_thinking") !== "false";
  const awaitContinuation = req.nextUrl.searchParams.get("await_continuation") === "true";
  const stream_options: StreamOptions = {
    filters: { include_tools: showTools, include_thinking: showThinking },
  };

  const run = getRun(thread_id);
  if (!run || (awaitContinuation && run.status !== "running")) {
    // Cold attach. If the per-thread queue already has work pending
    // (typical when the chat is reopened just after firing a scheduled
    // task / watcher / bridge turn — the request was enqueued via
    // Next's `after()` and hasn't reached `startRun` yet), hold the SSE
    // open briefly so we don't return a synthetic `done` for a run
    // that's about to register. If nothing appears in time, fall
    // through to the same `done`-and-close path as a truly idle thread.
    const queued = getQueueDepth(thread_id) > 0 ? await waitForRun(thread_id, 5000) : null;
    if (!queued) {
      const stream = new ReadableStream({
        start(controller) {
          try { controller.enqueue(sse({ type: "done" })); } catch { /* */ }
          try { controller.close(); } catch { /* */ }
        },
      });
      return sseResponse(stream);
    }
  }

  return attachStream(thread_id, stream_options, req.headers.get("last-event-id"));
}

const SteerBody = z.object({ message: z.string().min(1) });

// The steering text is already the last user row in the transcript, so the
// continuation only needs to explain why the agent is seeing it late.
const STEERING_CONTINUATION_PREFIX =
  "↪ You finished the previous reply before reading this. The user said, while you were still writing:\n\n";

// PATCH steers the currently-running agent: the message is queued and the
// agent's preModelHook delivers it before the next model call, alongside the
// tool results it should react to (ADR-0080). 409 means there was nothing to
// steer, and the caller should submit a normal run instead.
export async function PATCH(req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  const body = await validateBody(req, SteerBody);
  if (body instanceof NextResponse) return body;

  if (!pushSteering(thread_id, body.message)) {
    return NextResponse.json({ steered: false, reason: "no_active_run" }, { status: 409 });
  }
  // Persist only once the queue accepted it, so a 409 fallback to POST /run
  // doesn't write the same message twice.
  addMessage(thread_id, "user", body.message);
  return NextResponse.json({ steered: true });
}

// DELETE aborts the currently-running agent for this thread. The agent stream
// loop in llm.ts catches the resulting AbortError and emits a synthetic
// `error` + `done` event pair so subscribers (and the client's queue-drain
// hook) finish cleanly.
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  const aborted = abortRun(thread_id, "user_interrupted");
  return new Response(JSON.stringify({ aborted }), {
    status: aborted ? 200 : 404,
    headers: { "Content-Type": "application/json" },
  });
}

function attachStream(
  thread_id: string,
  stream_options?: StreamOptions,
  lastEventId?: string | null,
): Response {
  // Captured by both start() and cancel() so the cancel branch can tear
  // down the poll timer + subscription when the client disconnects.
  // Without this, navigating away from a long-running thread leaks an
  // event subscriber + 2Hz setInterval per visit until the run finishes
  // (or forever if it doesn't).
  let poll: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let clientGone = false;

  const stream = new ReadableStream({
    start(controller) {
      const safeEnqueue = (chunk: Uint8Array): void => {
        if (clientGone) return;
        try { controller.enqueue(chunk); } catch { clientGone = true; }
      };

      const onEvent = (ev: StreamChunk, eventId: string) => {
        if (!shouldEmitChunk(ev.type, stream_options)) return;
        safeEnqueue(sse({ type: ev.type, ...ev.data }, eventId));
      };

      const sub = subscribe(thread_id, onEvent, lastEventId, (run) => {
        const toolEvents = run.events.filter((event) =>
          ["tool_call", "tool_result", "tool_progress"].includes(event.type)
          && shouldEmitChunk(event.type, stream_options));
        safeEnqueue(sse({
          type: "stream_snapshot",
          text: run.final_text,
          tool_events: toolEvents.map((event) => ({ type: event.type, ...event.data })),
          message: "The replay cursor expired or changed. Restored current response; earlier tool details may be unavailable. No actions were restarted.",
        }, `${run.id}:${run.event_sequence}`));
        if (run.status !== "running") {
          const terminal = [...run.events].reverse().find((event) => event.type === "error")
            ?? [...run.events].reverse().find((event) => event.type === "done");
          safeEnqueue(sse(terminal ? { type: terminal.type, ...terminal.data } : { type: "done" }));
        }
      });
      unsubscribe = sub.unsubscribe;
      if (!sub.run) {
        try { controller.close(); } catch { /* */ }
        return;
      }

      // If run already terminal, close after replay.
      if (sub.run.status !== "running") {
        try { controller.close(); } catch { /* */ }
        return;
      }

      // When the run finishes (status changes), close our response. We
      // poll lightly because the run might finish due to other subscribers'
      // signals; simpler than wiring a second listener channel.
      poll = setInterval(() => {
        const r = getRun(thread_id);
        if (!r || r.status !== "running") {
          if (poll) { clearInterval(poll); poll = null; }
          if (unsubscribe) { unsubscribe(); unsubscribe = null; }
          if (!clientGone) {
            try { controller.close(); } catch { /* */ }
          }
        }
      }, 500);
      poll.unref?.();
    },
    cancel() {
      // Client navigated away — agent run keeps going in registry, but
      // tear down OUR poll + subscription so we don't leak a timer +
      // subscriber per disconnect.
      clientGone = true;
      if (poll) { clearInterval(poll); poll = null; }
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    },
  });

  return sseResponse(stream);
}
