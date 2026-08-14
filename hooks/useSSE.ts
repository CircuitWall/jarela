"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, submitRun, subscribeRun } from "@/api/client";
import type { ContentPart, SSEEventType, StreamOptions } from "@/api/types";
import type { ToolEvent } from "@/components/chat/ToolList";
import { pushActivity } from "@/lib/ui/loading";

export type { ToolEvent };

type AuthError = { message: string; credential_id?: string; provider?: string } | null;

function useRunActivity() {
  const activityRef = useRef<ReturnType<typeof pushActivity> | null>(null);
  const activeToolsRef = useRef<Map<string, string>>(new Map());

  const open = useCallback((initial: string) => {
    activityRef.current?.clear();
    activeToolsRef.current.clear();
    activityRef.current = pushActivity(initial);
  }, []);

  const close = useCallback(() => {
    activityRef.current?.clear();
    activityRef.current = null;
    activeToolsRef.current.clear();
  }, []);

  const setStatus = useCallback((label: string) => {
    activityRef.current?.set(label);
  }, []);

  const onToolCall = useCallback((id: string, name: string) => {
    activeToolsRef.current.set(id, name);
    activityRef.current?.set(`Using ${name}…`);
  }, []);

  const onToolResult = useCallback((id: string) => {
    activeToolsRef.current.delete(id);
    const remaining = activeToolsRef.current.values().next().value as string | undefined;
    activityRef.current?.set(remaining ? `Using ${remaining}…` : "Thinking…");
  }, []);

  useEffect(() => close, [close]);

  return { open, close, setStatus, onToolCall, onToolResult, activeToolsRef };
}

function useStreamingBuffer() {
  const [streamingContent, setStreamingContent] = useState("");
  const [thinkingContent, setThinkingContent] = useState("");
  const pendingTextRef = useRef("");
  const pendingThinkingRef = useRef("");
  const rafIdRef = useRef<number | null>(null);

  const flushPending = useCallback(() => {
    rafIdRef.current = null;
    if (pendingTextRef.current) {
      const delta = pendingTextRef.current;
      pendingTextRef.current = "";
      setStreamingContent((p) => p + delta);
    }
    if (pendingThinkingRef.current) {
      const delta = pendingThinkingRef.current;
      pendingThinkingRef.current = "";
      setThinkingContent((p) => p + delta);
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (rafIdRef.current !== null) return;
    if (typeof requestAnimationFrame === "undefined") {
      flushPending();
      return;
    }
    rafIdRef.current = requestAnimationFrame(flushPending);
  }, [flushPending]);

  const appendText = useCallback((delta: string) => {
    pendingTextRef.current += delta;
    scheduleFlush();
  }, [scheduleFlush]);

  const appendThinking = useCallback((delta: string) => {
    pendingThinkingRef.current += delta;
    scheduleFlush();
  }, [scheduleFlush]);

  const cancelPendingFlush = useCallback(() => {
    if (rafIdRef.current !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = null;
    pendingTextRef.current = "";
    pendingThinkingRef.current = "";
  }, []);

  const reset = useCallback(() => {
    cancelPendingFlush();
    setStreamingContent("");
    setThinkingContent("");
  }, [cancelPendingFlush]);

  const clearStreamingContent = useCallback(() => {
    setStreamingContent("");
  }, []);

  useEffect(() => () => { cancelPendingFlush(); }, [cancelPendingFlush]);

  return {
    streamingContent,
    thinkingContent,
    appendText,
    appendThinking,
    flushPending,
    cancelPendingFlush,
    reset,
    clearStreamingContent,
  };
}

// Single-transport agent run hook (ADR-0008): one POST to submit + one
// `EventSource` (under the hood) to subscribe. The hook keeps a stable
// surface for `ChatView` — `start`, `attach`, `stop`, `streaming`,
// `streamingContent`, etc. — even though the transport underneath collapsed
// from three legs (WS sidecar / SSE-POST / SSE-GET reattach) to one.
export function useSSE(onDone?: () => void) {
  const [streaming, setStreaming] = useState(false);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Structured auth-failure surface: when set, ChatView renders a banner
  // that deep-links to /settings/credentials for the offending row.
  // Cleared on every new start()/attach().
  const [authError, setAuthError] = useState<AuthError>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadIdRef = useRef<string | null>(null);
  const activity = useRunActivity();
  const buffer = useStreamingBuffer();

  // Abort the active EventSource on unmount so the server connection closes
  // and we don't call state setters on a dead component.
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const consume = useCallback(async (
    iterable: AsyncIterable<string>,
  ): Promise<void> => {
    for await (const raw of iterable) {
      let event: SSEEventType;
      try {
        event = JSON.parse(raw) as SSEEventType;
      } catch {
        continue;
      }
      if (event.type === "text_delta") {
        buffer.appendText(event.delta);
        activity.setStatus("Responding…");
      } else if (event.type === "status") {
        const label = typeof event.label === "string" && event.label.trim().length > 0
          ? event.label
          : "Thinking…";
        activity.setStatus(label);
      } else if (event.type === "thinking_delta") {
        buffer.appendThinking(event.delta);
        if (activity.activeToolsRef.current.size === 0) activity.setStatus("Thinking…");
      } else if (event.type === "tool_call") {
        // Flush any buffered text before the tool event so the order on
        // screen matches the order on the wire.
        buffer.flushPending();
        setToolEvents((prev) => [
          ...prev,
          { id: event.id, phase: "call", name: event.name, payload: event.arguments },
        ]);
        activity.onToolCall(event.id, event.name);
      } else if (event.type === "tool_result") {
        buffer.flushPending();
        setToolEvents((prev) => [
          ...prev,
          { id: event.id, phase: "result", name: event.name, payload: event.result },
        ]);
        activity.onToolResult(event.id);
      } else if (event.type === "done") {
        buffer.flushPending();
        setStreaming(false);
        activity.close();
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
        buffer.cancelPendingFlush();
        setStreaming(false);
        activity.close();
        setError(event.message);
        if (event.code === "auth_failed") {
          setAuthError({
            message: event.message,
            credential_id: event.credential_id,
            provider: event.provider,
          });
        }
        // Keep streamingContent/thinkingContent visible — same pattern as
        // `done` and stop(). onDone triggers finalizeRunFromServer which
        // fetches whatever the server persisted (partial content + interrupt
        // marker) and then calls clearStreaming(). Clearing here would blank
        // the bubble before the persisted row arrives.
        onDone?.();
        break;
      }
    }
  }, [activity, buffer, onDone]);

  const start = useCallback(async (
    threadId: string,
    message: string,
    options?: StreamOptions,
    attachments?: ContentPart[],
    hotSince?: string | null,
  ): Promise<{ accepted: boolean }> => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    threadIdRef.current = threadId;
    buffer.reset();
    setStreaming(true);
    setToolEvents([]);
    setError(null);
    setAuthError(null);
    activity.open("Sending…");

    try {
      // Command: register the run server-side. 202 = we own this turn; 409
      // = another tab/device owns it (caller re-queues, we still subscribe
      // so the user sees the in-flight turn's deltas render).
      const submit = await submitRun(threadId, message, ctrl.signal, options, attachments, hotSince);

      // Query: subscribe to the run's chunk stream. Always opens the GET,
      // regardless of whether we got 202 or 409 — if 409 a run is already
      // in flight on the server and we want to observe it.
      await consume(subscribeRun(threadId, ctrl.signal, options));
      return { accepted: submit.accepted };
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(String(err));
      }
      return { accepted: false };
    } finally {
      // Always release the gate when the stream ends — defends against the
      // consume() loop returning without ever observing a terminal `done`
      // event (e.g. the EventSource closed cleanly with zero events). If
      // we relied solely on the `done` branch inside consume(), the chat
      // would stay locked behind the Stop button forever.
      //
      // We intentionally do NOT clear streamingContent / thinkingContent
      // here — the consumer (ChatView) swaps them for the persisted
      // assistant bubble once the refetch lands; clearing now would yank
      // the text out from under the user. The next start()/attach() resets
      // them.
      setStreaming(false);
      activity.close();
    }
  }, [activity, buffer, consume]);

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
    buffer.flushPending();
    setStreaming(false);
    // Keep streamingContent and thinkingContent visible until the next
    // start()/attach() — same pattern as the `done` branch in consume().
    activity.close();
    abortRef.current?.abort();
    onDone?.();
  }, [activity, buffer, onDone]);

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
    buffer.reset();
    setStreaming(true);
    setToolEvents([]);
    setError(null);
    setAuthError(null);
    activity.open("Reconnecting…");

    try {
      await consume(subscribeRun(threadId, ctrl.signal));
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onDone?.();
      }
    } finally {
      // Always release the optimistic gate when the stream ends — whether
      // via terminal `done`/`error` event, a thrown failure, or a clean
      // EventSource close with no events (idle thread, server returned 404
      // so the iterator exited without yielding). Without this, navigating
      // into an idle thread leaves streaming=true forever: the Stop button
      // hangs in the composer and the "Reconnecting…" badge never clears.
      setStreaming(false);
      activity.close();
    }
  }, [activity, buffer, consume, onDone]);

  // Called by the consumer after a refetch lands, so the streaming bubble
  // gets swapped for the persisted assistant message in a single render.
  const dismissAuthError = useCallback(() => { setAuthError(null); }, []);

  return {
    streaming,
    streamingContent: buffer.streamingContent,
    thinkingContent: buffer.thinkingContent,
    toolEvents,
    error,
    authError,
    dismissAuthError,
    start,
    stop,
    attach,
    clearStreamingContent: buffer.clearStreamingContent,
  };
}
