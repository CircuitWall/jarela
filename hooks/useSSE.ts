"use client";
import { useCallback, useRef, useState } from "react";
import { api, streamChat, streamChatWS } from "@/api/client";
import type { ContentPart, SSEEventType, StreamOptions } from "@/api/types";

export interface ToolEvent {
  id: string;
  phase: "call" | "result";
  name: string;
  payload: unknown;
}

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
      } catch {
        await consume(streamChat(threadId, message, ctrl.signal, options, attachments), "sse");
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(String(err));
      }
      setStreaming(false);
      setStreamingContent("");
      setThinkingContent("");
    }
  }, [consume]);

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
  // because the user switched away). No-ops if no run is active.
  const attach = useCallback(async (threadId: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    threadIdRef.current = threadId;
    setStreamingContent("");
    setThinkingContent("");
    setToolEvents([]);
    setError(null);

    try {
      const res = await fetch(`/api/v1/threads/${threadId}/run`, { signal: ctrl.signal });
      if (res.status === 404) return; // no run to attach to
      if (!res.ok || !res.body) return;
      setStreaming(true);
      setTransport("sse");

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
      if ((err as Error).name !== "AbortError") {
        // attach failures are non-fatal — silently fall back to "no live run".
      }
      setStreaming(false);
    }
  }, [consume]);

  // Called by the consumer after a refetch lands, so the streaming bubble
  // gets swapped for the persisted assistant message in a single render.
  const clearStreamingContent = useCallback(() => { setStreamingContent(""); }, []);

  return { streaming, transport, streamingContent, thinkingContent, toolEvents, error, start, stop, attach, clearStreamingContent };
}
