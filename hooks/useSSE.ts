"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, submitRun, subscribeRun } from "@/api/client";
import type { ContentPart, SSEEventType, StreamOptions } from "@/api/types";
import type { ToolEvent } from "@/components/chat/ToolList";
import { pushActivity } from "@/lib/ui/loading";

export type { ToolEvent };

// Single-transport agent run hook (ADR-0008): one POST to submit + one
// `EventSource` (under the hood) to subscribe. The hook keeps a stable
// surface for `ChatView` — `start`, `attach`, `stop`, `streaming`,
// `streamingContent`, etc. — even though the transport underneath collapsed
// from three legs (WS sidecar / SSE-POST / SSE-GET reattach) to one.
export function useSSE(onDone?: () => void) {
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [thinkingContent, setThinkingContent] = useState("");
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadIdRef = useRef<string | null>(null);
  // Live "what is the agent doing" label, surfaced in the app header. The
  // slot stays open for the duration of one run; we mutate its label as
  // tool calls come and go so the header text updates in place without
  // pushing/popping (which would flicker stacked activities).
  const activityRef = useRef<ReturnType<typeof pushActivity> | null>(null);
  const activeToolsRef = useRef<Map<string, string>>(new Map());

  const openActivity = useCallback((initial: string) => {
    activityRef.current?.clear();
    activeToolsRef.current.clear();
    activityRef.current = pushActivity(initial);
  }, []);

  const closeActivity = useCallback(() => {
    activityRef.current?.clear();
    activityRef.current = null;
    activeToolsRef.current.clear();
  }, []);

  // Always release the activity label if the hook unmounts mid-run, so a
  // dangling "thinking…" can't outlive its session.
  useEffect(() => closeActivity, [closeActivity]);

  const consume = useCallback(async (
    iterable: AsyncIterable<string>,
  ): Promise<void> => {
    for await (const raw of iterable) {
      const event = JSON.parse(raw) as SSEEventType;
      if (event.type === "text_delta") {
        setStreamingContent((p) => p + event.delta);
        activityRef.current?.set("Responding…");
      } else if (event.type === "thinking_delta") {
        setThinkingContent((p) => p + event.delta);
        if (activeToolsRef.current.size === 0) activityRef.current?.set("Thinking…");
      } else if (event.type === "tool_call") {
        setToolEvents((prev) => [
          ...prev,
          { id: event.id, phase: "call", name: event.name, payload: event.arguments },
        ]);
        activeToolsRef.current.set(event.id, event.name);
        activityRef.current?.set(`Using ${event.name}…`);
      } else if (event.type === "tool_result") {
        setToolEvents((prev) => [
          ...prev,
          { id: event.id, phase: "result", name: event.name, payload: event.result },
        ]);
        activeToolsRef.current.delete(event.id);
        const remaining = activeToolsRef.current.values().next().value as string | undefined;
        activityRef.current?.set(remaining ? `Using ${remaining}…` : "Thinking…");
      } else if (event.type === "done") {
        setStreaming(false);
        closeActivity();
        // Don't clear streamingContent here — it would cause a visual gap
        // between "stream done" and "refetched messages arrived" where the
        // assistant bubble disappears for ~100ms. The consumer (ChatView)
        // calls clearStreamingContent after refetch lands, swapping the
        // streaming bubble for the persisted message in a single render.
        // Don't clear thinkingContent either: thinking isn't persisted on
        // the message, so clearing here would yank it out from under a user
        // who's still reading. It clears on the next start()/attach().
        onDone?.();
        break;
      } else if (event.type === "error") {
        setStreaming(false);
        setStreamingContent("");
        setThinkingContent("");
        closeActivity();
        setError(event.message);
        break;
      }
    }
  }, [onDone, closeActivity]);

  const start = useCallback(async (
    threadId: string,
    message: string,
    options?: StreamOptions,
    attachments?: ContentPart[],
  ): Promise<{ accepted: boolean }> => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    threadIdRef.current = threadId;
    setStreaming(true);
    setStreamingContent("");
    setThinkingContent("");
    setToolEvents([]);
    setError(null);
    openActivity("Sending…");

    try {
      // Command: register the run server-side. 202 = we own this turn; 409
      // = another tab/device owns it (caller re-queues, we still subscribe
      // so the user sees the in-flight turn's deltas render).
      const submit = await submitRun(threadId, message, ctrl.signal, options, attachments);

      // Query: subscribe to the run's chunk stream. Always opens the GET,
      // regardless of whether we got 202 or 409 — if 409 a run is already
      // in flight on the server and we want to observe it.
      await consume(subscribeRun(threadId, ctrl.signal, options));
      return { accepted: submit.accepted };
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(String(err));
      }
      setStreaming(false);
      setStreamingContent("");
      setThinkingContent("");
      closeActivity();
      return { accepted: false };
    }
  }, [consume, openActivity, closeActivity]);

  // Stop the active run. Three-part: (1) tell the server to abort the
  // agent stream so the LangGraph loop unwinds; (2) tear down local
  // streaming state immediately so the UI gates release and the queue
  // drains — we cannot rely on the server's `error`+`done` round-trip
  // because step (3) closes the EventSource before those broadcasts
  // arrive; (3) abort the local controller so the EventSource closes
  // and the iterator's finally{} fires. Without step (2) the consume()
  // loop exits via its abort path (no terminal event) and never calls
  // setStreaming(false) / onDone — the chat appears frozen and the only
  // recovery is a full refresh.
  const stop = useCallback(() => {
    const tid = threadIdRef.current;
    if (tid) {
      void api.threads.abortRun(tid).catch(() => { /* server already idle */ });
    }
    setStreaming(false);
    // Keep streamingContent and thinkingContent visible until the next
    // start()/attach() — same pattern as the `done` branch in consume().
    closeActivity();
    abortRef.current?.abort();
    onDone?.();
  }, [onDone, closeActivity]);

  // Attach to an in-flight run for the given thread (server-side run kept
  // going because the user switched away, or because this is a fresh
  // navigation into a session whose run is still streaming). Sets
  // `streaming` optimistically BEFORE the GET resolves so the input bar
  // gates / Stop button shows / queue drain blocks immediately on session
  // open — otherwise there's a race window where the UI thinks no run is
  // active, accepts a new POST, and the server rejects it with 409.
  const attach = useCallback(async (threadId: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    threadIdRef.current = threadId;
    setStreaming(true);
    setStreamingContent("");
    setThinkingContent("");
    setToolEvents([]);
    setError(null);
    openActivity("Reconnecting…");

    try {
      await consume(subscribeRun(threadId, ctrl.signal));
    } catch (err) {
      // Attach failures are non-fatal — clear the gate and let the consumer
      // drain anything queued during session load. The common case is
      // "no run to attach to" (server returns 404, EventSource fails to
      // open) — completely normal when navigating into an idle session.
      setStreaming(false);
      closeActivity();
      if ((err as Error).name !== "AbortError") {
        onDone?.();
      }
    }
  }, [consume, onDone, openActivity, closeActivity]);

  // Called by the consumer after a refetch lands, so the streaming bubble
  // gets swapped for the persisted assistant message in a single render.
  const clearStreamingContent = useCallback(() => { setStreamingContent(""); }, []);

  return { streaming, streamingContent, thinkingContent, toolEvents, error, start, stop, attach, clearStreamingContent };
}
