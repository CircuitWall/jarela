import { NextRequest } from "next/server";
import type { StreamOptions, StreamChunk } from "@/lib/agents/base";
import type { ContentPart } from "@/lib/tools/types";
import {
  prepareThreadRun,
  persistAssistantMessage,
  RunThreadError,
  shouldEmitChunk,
} from "@/lib/agents/run-thread";
import { broadcast, finishRun, startRun, subscribe, abortRun, getRun } from "@/lib/agents/run-registry";
import { collectStream } from "@/lib/agents/stream-collector";
import { getThread } from "@/lib/stores/threads";
import { publish as publishNotification } from "@/lib/notifications/bus";
import { sseResponse } from "@/lib/api/sse";

type Params = { params: Promise<{ thread_id: string }> };

const enc = new TextEncoder();
const sse = (obj: Record<string, unknown>) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

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
  const { message, attachments, stream_options, hot_since } = (await req.json()) as {
    message: string;
    attachments?: ContentPart[];
    stream_options?: StreamOptions;
    // ADR-0042 — explicit context boundary the chat picked. ISO timestamp,
    // null to clear the pin, omitted to leave whatever's already persisted
    // on the thread.
    hot_since?: string | null;
  };

  // Connection-level handoff (NOT a kill). If a run is already in flight
  // for this thread — second tab, another device, a flaky-mobile retry —
  // refuse the new submission with 409. The caller is expected to:
  //   1) roll back any optimistic user bubble it added,
  //   2) re-queue the message locally to resubmit after the current turn
  //      finishes,
  //   3) open the GET subscription so the user still sees the in-flight
  //      turn's deltas render.
  const existing = getRun(thread_id);
  if (existing && existing.status === "running") {
    return new Response(
      JSON.stringify({ accepted: false, code: "run_in_flight", thread_id }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
  }

  const thread = getThread(thread_id);
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
    });
  } catch (err) {
    // Prep failure (unknown agent, model misconfig, …) — drop the run we
    // just registered and surface a synchronous error to the caller.
    finishRun(active, "error");
    if (err instanceof RunThreadError) {
      return new Response(
        JSON.stringify({ accepted: false, error: err.message, code: err.code }),
        { status: err.status, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ accepted: false, error: String(err), code: "run_prepare_error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Drive the agent to completion regardless of client connection. Events
  // go to the registry; the GET subscriber (and any reattaching clients)
  // receive them via subscribe().
  //
  // CRITICAL: finishRun() MUST run no matter what — if it doesn't, the
  // run is pinned as "running" forever, every subsequent POST returns
  // 409 run_in_flight, and the user sees a silently-dead chat. The TTL
  // eviction is scheduled inside finishRun(), so a leaked entry never
  // self-heals. Wrap the whole body in try/finally.
  void (async () => {
    let terminal: "done" | "error" = "error";
    let assistantContent = "";
    try {
      const collected = await collectStream(prepared.stream as AsyncIterable<StreamChunk>, {
        onChunk: (chunk) => broadcast(active, chunk),
      });
      assistantContent = collected.assistantContent;
      terminal = collected.terminal;
      // If the stream threw mid-iteration, collectStream returns terminal="error"
      // but no `error` chunk was broadcast — surface one to subscribers.
      if (collected.terminal === "error" && collected.errorMessage) {
        broadcast(active, {
          type: "error",
          data: { message: collected.errorMessage, code: "stream_error" },
        });
      }
      try {
        persistAssistantMessage(thread_id, collected.assistantContent, collected.usedTools, collected.toolEvents, null, collected.usage ?? null, prepared.context_snapshot ?? null);
      } catch (persistErr) {
        // Persistence failure must not strand the run — surface and continue
        // to finishRun in the finally block.
        terminal = "error";
        broadcast(active, {
          type: "error",
          data: { message: `persist failed: ${(persistErr as Error).message}`, code: "persist_error" },
        });
      }
    } catch (err) {
      // Unhandled throw from collectStream / the underlying stream. Without
      // this catch, finishRun would never run and the registry entry would
      // stick as "running" indefinitely (see CRITICAL note above).
      terminal = "error";
      broadcast(active, {
        type: "error",
        data: { message: (err as Error).message ?? String(err), code: "run_crashed" },
      });
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
  })();

  return new Response(
    JSON.stringify({ accepted: true, thread_id, started_at: active.started_at }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
}

// GET is the *query* half of the run lifecycle (ADR-0008). Attaches to an
// active (or recently-finished, within the registry TTL) run and streams
// chunks as Server-Sent Events. Always consumed client-side via
// `EventSource` — never `fetch().body.getReader()`, which is unreliable on
// iOS Safari for long-lived streaming responses.
//
// Returns 404 with no body if there's no run to attach to (run never
// existed, or it finished + TTL-evicted before the GET arrived).
//
// `show_tools` / `show_thinking` query params let the caller suppress
// chunk types it doesn't want to render. Defaults: both on. The full
// `StreamOptions` shape is only meaningful on the POST (tool policy &
// agent run config are run-wide settings, not per-subscriber filters).
export async function GET(req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  const run = getRun(thread_id);
  if (!run) return new Response(null, { status: 404 });

  const showTools = req.nextUrl.searchParams.get("show_tools") !== "false";
  const showThinking = req.nextUrl.searchParams.get("show_thinking") !== "false";
  const stream_options: StreamOptions = {
    filters: { include_tools: showTools, include_thinking: showThinking },
  };
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
  const stream = new ReadableStream({
    start(controller) {
      let clientGone = false;
      const safeEnqueue = (chunk: Uint8Array): void => {
        if (clientGone) return;
        try { controller.enqueue(chunk); } catch { clientGone = true; }
      };

      const onEvent = (ev: StreamChunk) => {
        if (!shouldEmitChunk(ev.type, stream_options)) return;
        safeEnqueue(sse({ type: ev.type, ...ev.data }));
      };

      const { run, unsubscribe } = subscribe(thread_id, onEvent);
      if (!run) {
        controller.close();
        return;
      }

      // If run already terminal, close after replay.
      if (run.status !== "running") {
        try { controller.close(); } catch { /* */ }
        return;
      }

      // When the run finishes (status changes), close our response. We
      // poll lightly because the run might finish due to other subscribers'
      // signals; simpler than wiring a second listener channel.
      const poll = setInterval(() => {
        const r = getRun(thread_id);
        if (!r || r.status !== "running") {
          clearInterval(poll);
          unsubscribe();
          if (!clientGone) {
            try { controller.close(); } catch { /* */ }
          }
        }
      }, 500);
      poll.unref?.();
    },
    cancel() {
      // Client navigated away — agent run keeps going in registry.
    },
  });

  return sseResponse(stream);
}
