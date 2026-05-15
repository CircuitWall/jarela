import { NextRequest } from "next/server";
import type { StreamOptions, StreamChunk } from "@/lib/agents/base";
import type { ContentPart } from "@/lib/tools/types";
import {
  prepareThreadRun,
  persistAssistantMessage,
  RunThreadError,
  shouldEmitChunk,
} from "@/lib/agents/run-thread";
import { broadcast, finishRun, getRun, startRun, subscribe } from "@/lib/agents/run-registry";
import { getThread } from "@/lib/stores/threads";
import { publish as publishNotification } from "@/lib/notifications/bus";

type Params = { params: Promise<{ thread_id: string }> };

const enc = new TextEncoder();
const sse = (obj: Record<string, unknown>) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

export async function POST(req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  const { message, attachments, stream_options } = (await req.json()) as {
    message: string;
    attachments?: ContentPart[];
    stream_options?: StreamOptions;
  };

  // Refuse a second concurrent run on the same thread — the first must finish
  // (or be abandoned via TTL eviction). Clients can attach via GET instead.
  const existing = getRun(thread_id);
  if (existing && existing.status === "running") {
    return new Response(
      JSON.stringify({ error: "A run is already in progress for this thread", code: "run_active" }),
      { status: 409 },
    );
  }

  let prepared;
  try {
    prepared = await prepareThreadRun(thread_id, message, stream_options, attachments);
  } catch (err) {
    if (err instanceof RunThreadError) {
      return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: err.status });
    }
    return new Response(JSON.stringify({ error: String(err), code: "run_prepare_error" }), { status: 500 });
  }

  const thread = getThread(thread_id);
  startRun(thread_id, thread?.agent_id ?? null);

  // Drive the agent to completion regardless of client connection. Events go
  // to the registry; subscribers (including this response stream) receive them.
  void (async () => {
    let assistantContent = "";
    let terminal: "done" | "error" = "done";
    try {
      for await (const chunk of prepared.stream as AsyncIterable<StreamChunk>) {
        if (chunk.type === "text_delta") {
          assistantContent += (chunk.data.delta as string) ?? "";
        }
        broadcast(thread_id, chunk);
        if (chunk.type === "error") terminal = "error";
        if (chunk.type === "done" || chunk.type === "error") break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      broadcast(thread_id, { type: "error", data: { message: msg, code: "stream_error" } });
      terminal = "error";
    } finally {
      persistAssistantMessage(thread_id, assistantContent);
      finishRun(thread_id, terminal);
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

  return attachStream(thread_id, stream_options);
}

// GET attaches to an active or recently-finished run for this thread.
// Returns 404 (no body) if there's no run to attach to.
export async function GET(_req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  const run = getRun(thread_id);
  if (!run) return new Response(null, { status: 404 });
  return attachStream(thread_id);
}

function attachStream(thread_id: string, stream_options?: StreamOptions): Response {
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

      // When the run finishes (status changes), close our response.
      // We poll lightly because the run might finish due to other subscribers'
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

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
