"use client";
import { useCallback, useRef, useState } from "react";
import { api, streamChat, streamChatWS } from "@/api/client";
import type { ContentPart, SSEEventType, StreamOptions } from "@/api/types";
import type { ToolEvent } from "@/components/chat/ToolList";

export type { ToolEvent };

export function useSSE(onDone?: () => void) {
  const [streaming, setStreaming] = useState(false);
  const [transport, setTransport] = useState<"ws" | "sse">("sse");
  const [streamingContent, setStreamingContent] = useState("");
  const [thinkingContent, setThinkingContent] = useState("");
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadIdRef = useRef<string | null>(null);

  const consume = useCallback(async (
    iterable: AsyncIterable<string>,
    transportType: "ws" | "sse",
  ) => {
    setTransport(transportType);
    for await (const raw of iterable) {
      const event = JSON.parse(raw) as SSEEventType;
      if (event.type === "text_delta") {
        setStreamingContent((p) => p + event.delta);
      } else if (event.type === "thinking_delta") {
        setThinkingContent((p) => p + event.delta);
      } else if (event.type === "tool_call") {
        setToolEvents((prev) => [
          ...prev,
          { id: event.id, phase: "call", name: event.name, payload: event.arguments },
        ]);
      } else if (event.type === "tool_result") {
        setToolEvents((prev) => [
          ...prev,
          { id: event.id, phase: "result", name: event.name, payload: event.result },
        ]);
      } else if (event.type === "done") {
        setStreaming(false);
        // Don't clear streamingContent here — it would cause a visual gap
        // between "stream done" and "refetched messages arrived" where the
        // assistant bubble disappears for ~100ms. The consumer (ChatView)
        // calls clearStreamingContent after refetch lands, swapping the
        // streaming bubble for the persisted message in a single render.
        setThinkingContent("");
        onDone?.();
        break;
      } else if (event.type === "error") {
        setStreaming(false);
        setStreamingContent("");
        setThinkingContent("");
        setError(event.message);
        break;
      }
    }
  }, [onDone]);

  // Subscribe to an already-running server-side run via SSE GET. Used when
  // the WS dropped mid-stream and the run is still alive in the registry.
  // Re-uses the provided AbortController so the caller's stop()/teardown
  // still works without spawning a second controller.
  const consumeAttach = useCallback(async (threadId: string, signal: AbortSignal) => {
    const res = await fetch(`/api/v1/threads/${threadId}/run`, { signal });
    if (res.status === 404) {
      // Run already finished and was evicted before we could reattach. The
      // assistant message was persisted in finally{} server-side — surface a
      // synthetic done so the queue-drain / refetch in ChatView fires.
      setStreaming(false);
      setThinkingContent("");
      onDone?.();
      return;
    }
    if (!res.ok || !res.body) {
      throw new Error(`reattach failed: ${res.status}`);
    }
    const iter = (async function* () {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data: ")) yield line.slice(6).trim();
          }
        }
      } finally { reader.releaseLock(); }
    })();
    // Replay arrives as deltas — but the streaming bubble already shows
    // whatever the WS managed to render before dropping. Reset so we don't
    // double-render the prefix.
    setStreamingContent("");
    setThinkingContent("");
    setToolEvents([]);
    await consume(iter, "sse");
  }, [consume, onDone]);

  const start = useCallback(async (threadId: string, message: string, options?: StreamOptions, attachments?: ContentPart[]) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    threadIdRef.current = threadId;
    setStreaming(true);
    setStreamingContent("");
    setThinkingContent("");
    setToolEvents([]);
    setError(null);

    try {
      try {
        await consume(streamChatWS(threadId, message, ctrl.signal, options, attachments), "ws");
      } catch (innerErr) {
        // A mid-stream WS drop (iOS suspend, mobile signal blip) means the
        // server-side run is still alive in the registry — reattach via SSE
        // GET so we replay buffered events and pick up the terminal `done`.
        // POSTing a new SSE run here would either 409 or duplicate the turn.
        const code = (innerErr as { code?: string } | null)?.code;
        if (code === "ws_drop_reattach") {
          await consumeAttach(threadId, ctrl.signal);
        } else {
          await consume(streamChat(threadId, message, ctrl.signal, options, attachments), "sse");
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(String(err));
      }
      setStreaming(false);
      setStreamingContent("");
      setThinkingContent("");
    }
  }, [consume, consumeAttach]);

  // Stop the active run. Two-part: (1) tell the server to abort the agent
  // stream so the LangGraph loop unwinds and downstream subscribers see a
  // terminal event; (2) abort the local fetch/WS as a fallback in case the
  // network request itself is stuck. The server send `error` + `done` so the
  // ChatView queue-drain still fires after an interrupt.
  const stop = useCallback(() => {
    const tid = threadIdRef.current;
    if (tid) {
      void api.threads.abortRun(tid).catch(() => { /* server already idle */ });
    }
    abortRef.current?.abort();
  }, []);

  // Attach to an in-flight run for the given thread (server-side run kept going
  // because the user switched away, or because this is a fresh navigation
  // into a session whose run is still streaming). Sets `streaming` optimistically
  // BEFORE the probe fetch resolves so the input bar gates / Stop button
  // shows / queue drain blocks immediately on session open — otherwise there's
  // a race window where the UI thinks no run is active, accepts a new POST,
  // and the server rejects it with "A run is already active".
  const attach = useCallback(async (threadId: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    threadIdRef.current = threadId;
    setStreaming(true);
    setTransport("sse");
    setStreamingContent("");
    setThinkingContent("");
    setToolEvents([]);
    setError(null);

    try {
      const res = await fetch(`/api/v1/threads/${threadId}/run`, { signal: ctrl.signal });
      if (res.status === 404 || !res.ok || !res.body) {
        // No live run — clear the optimistic gate and signal completion so
        // the consumer drains any messages queued during session load.
        setStreaming(false);
        onDone?.();
        return;
      }

      const iter = (async function* () {
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              if (line.startsWith("data: ")) yield line.slice(6).trim();
            }
          }
        } finally { reader.releaseLock(); }
      })();
      await consume(iter, "sse");
    } catch (err) {
      // attach failures are non-fatal — clear the gate and let the consumer
      // drain anything queued during session load.
      setStreaming(false);
      if ((err as Error).name !== "AbortError") {
        onDone?.();
      }
    }
  }, [consume, onDone]);

  // Called by the consumer after a refetch lands, so the streaming bubble
  // gets swapped for the persisted assistant message in a single render.
  const clearStreamingContent = useCallback(() => { setStreamingContent(""); }, []);

  return { streaming, transport, streamingContent, thinkingContent, toolEvents, error, start, stop, attach, clearStreamingContent };
}
