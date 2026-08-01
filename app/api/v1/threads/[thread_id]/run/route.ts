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
import type { ContentPart } from "@/lib/tools/types";
import {
  prepareThreadRun,
  persistAssistantMessage,
  withInterruptMarker,
  RunThreadError,
  snapshotThreadModelConfigName,
  shouldEmitChunk,
} from "@/lib/agents/run-thread";
import { broadcast, finishRun, startRun, subscribe, abortRun, getRun, waitForRun } from "@/lib/agents/run-registry";
import { enqueueThreadRun, QueueFullError, getQueueDepth } from "@/lib/agents/run-queue";
import { collectStream } from "@/lib/agents/stream-collector";
import { getThread, addMessage } from "@/lib/stores/threads";
import { publish as publishNotification } from "@/lib/notifications/bus";
import { sseResponse } from "@/lib/api/sse";
import { validateBody } from "@/lib/api/responses";
import { resolveTurnProfile } from "@/lib/agents/turn-profile";

type Params = { params: Promise<{ thread_id: string }> };

const enc = new TextEncoder();
const sse = (obj: Record<string, unknown>) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

// Persist a `run_error` marker row so a failed turn survives reload and
// cross-device sync even when no assistant content was produced. The row
// is filtered out of the LLM history window (see getRecentMessagesWindow)
// and rendered as a compact chip by the chat UI. See ADR-0069.
interface RunErrorSource {
  errorMessage?: string;
  errorCode?: string;
  errorCredentialId?: string;
  errorProvider?: string;
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
  try {
    addMessage(thread_id, "assistant", truncated, null, "run_error", metadata);
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
  // ADR-0042 — explicit context boundary the chat picked. ISO timestamp,
  // null to clear the pin, omitted to leave whatever's already persisted
  // on the thread.
  hot_since: z.string().nullable().optional(),
});

// POST is the *command* half of the run lifecycle (ADR-0008). It accepts the
// new user message, registers a run in the in-memory registry, kicks the
// agent loop off in a detached async task, and returns 202 immediately. The
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
  const hot_since = parsed.hot_since;

  // Per-thread FIFO queue (lib/agents/run-queue.ts). Every entry point
  // that drives an agent on a thread goes through this — HTTP POST,
  // scheduler, watcher, trigger, bridge — so concurrent fires on the same
  // thread_id serialise instead of racing the LangGraph checkpoint store.
  // If the queue is already at the soft cap, reject with 503 so the
  // caller can back off rather than pin yet more work in memory.
  const thread = getThread(thread_id);
  const pinnedModelConfigName = snapshotThreadModelConfigName(thread_id);
  let position: number;
  try {
    ({ position } = enqueueThreadRun(thread_id, "user", async () => {
      // startRun is called once it's our turn so the registry only ever
      // holds one active entry per thread at a time. Subscribers that
      // attach via GET before our turn comes will see no run yet and the
      // SSE handler emits a synthetic done — the client reopens the
      // EventSource and picks up the stream once we're running.
      const active = startRun(thread_id, thread?.agent_id ?? null);
      let prepared;
      try {
        prepared = await prepareThreadRun({
          thread_id,
          message,
          options: stream_options,
          attachments,
          signal: active.abort.signal,
          hot_since,
          context_profile: resolveTurnProfile("user"),
          _pinned_model_config_name: pinnedModelConfigName,
        });
      } catch (err) {
        // Prep failure (unknown agent, model misconfig, …). With queueing
        // the HTTP request has already returned 202, so the error has to
        // surface as an SSE chunk to any attached subscriber. There may
        // be no subscriber if the GET hasn't connected yet — the chunk
        // is buffered on the ActiveRun for the next attach.
        const message_ = err instanceof RunThreadError ? err.message : String(err);
        const code = err instanceof RunThreadError ? err.code : "run_prepare_error";
        broadcast(active, { type: "error", data: { message: message_, code } });
        finishRun(active, "error");
        return;
      }

      // Drive the agent to completion regardless of client connection. Events
      // go to the registry; the GET subscriber (and any reattaching clients)
      // receive them via subscribe().
      //
      // CRITICAL: finishRun() MUST run no matter what — if it doesn't, the
      // run is pinned as "running" forever and the TTL eviction (scheduled
      // inside finishRun()) never fires, so a leaked entry never self-heals.
      // Wrap the whole body in try/finally.
      let terminal: "done" | "error" = "error";
      let assistantContent = "";
      try {
        const collected = await collectStream(prepared.stream as AsyncIterable<StreamChunk>, {
          onChunk: (chunk) => broadcast(active, chunk),
        });
        assistantContent = collected.assistantContent;
        terminal = collected.terminal;
        // If the stream threw mid-iteration, collectStream returns terminal="error"
        // but no `error` chunk was broadcast — surface one to subscribers. Skip
        // when the run was deliberately aborted: llm.ts already emitted an
        // `error{code:"aborted"}` chunk for that path and re-broadcasting as
        // `stream_error` would mask the intent.
        if (collected.terminal === "error" && collected.errorMessage && !collected.aborted) {
          broadcast(active, {
            type: "error",
            data: { message: collected.errorMessage, code: "stream_error" },
          });
        }
        try {
          // On a user abort (Stop / steer), append the interrupt footer so
          // the partial reply is never silently dropped and the next agent
          // turn sees a clear marker explaining the cut. withInterruptMarker
          // returns the bare marker when the partial is empty, which forces
          // persistAssistantMessage past its skip-empty guard so the thread
          // always has a row recording what happened.
          const contentToPersist = collected.aborted
            ? withInterruptMarker(collected.assistantContent)
            : collected.assistantContent;
          persistAssistantMessage(thread_id, contentToPersist, collected.usedTools, collected.toolEvents, null, collected.usage ?? null, prepared.context_snapshot ?? null, prepared.source_manifest ?? null);
          // If the turn failed AND persistAssistantMessage skipped writing
          // a row (no content + no tool events + not aborted), persist a
          // synthetic `run_error` marker so the failure survives reload
          // and cross-device sync. history-window filters these rows out
          // of the LLM budget; the UI renders them as a compact chip.
          // See ADR-0069.
          if (
            terminal === "error"
            && !collected.aborted
            && !collected.assistantContent.trim()
            && (!collected.toolEvents || collected.toolEvents.length === 0)
          ) {
            persistRunErrorMarker(thread_id, collected);
          }
        } catch (persistErr) {
          terminal = "error";
          broadcast(active, {
            type: "error",
            data: { message: `persist failed: ${(persistErr as Error).message}`, code: "persist_error" },
          });
        }
      } catch (err) {
        terminal = "error";
        const errMsg = (err as Error).message ?? String(err);
        broadcast(active, {
          type: "error",
          data: { message: errMsg, code: "run_crashed" },
        });
        // Same marker semantics as above but for the outer crash path — the
        // stream threw before collectStream could emit an error chunk.
        try {
          persistRunErrorMarker(thread_id, { errorMessage: errMsg, errorCode: "run_crashed" });
        } catch (persistErr) {
          console.error("[run] failed to persist run_error marker", persistErr);
        }
      } finally {
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

  return new Response(
    JSON.stringify({ accepted: true, thread_id, queue_position: position }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
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
  const stream_options: StreamOptions = {
    filters: { include_tools: showTools, include_thinking: showThinking },
  };

  const run = getRun(thread_id);
  if (!run) {
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

  return attachStream(thread_id, stream_options);
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

      const onEvent = (ev: StreamChunk) => {
        if (!shouldEmitChunk(ev.type, stream_options)) return;
        safeEnqueue(sse({ type: ev.type, ...ev.data }));
      };

      const sub = subscribe(thread_id, onEvent);
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
