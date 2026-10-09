"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, submitRun, subscribeRun } from "@/api/client";
import type { ContentPart, SSEEventType, StreamOptions } from "@/api/types";
import type { ToolEvent } from "@/components/chat/ToolList";
import type { UnifiedHookResult } from "@/hooks/useListState";
import { pushActivity } from "@/lib/ui/loading";

export type { ToolEvent };

type AuthError = { message: string; credential_id?: string; provider?: string } | null;
type SteeredSegment = { id: string; content: string };

type UseSSEState = {
  streaming: boolean;
  streamingContent: string;
  thinkingContent: string;
  toolEvents: ToolEvent[];
  error: string | null;
  authError: AuthError;
  steeredSegments: SteeredSegment[];
};
type UseSSECommands = {
  dismissAuthError: () => void;
  start: (
    threadId: string,
    message: string,
    options?: StreamOptions,
    attachments?: ContentPart[],
    hotSince?: string | null,
    channels?: string[],
  ) => Promise<{ accepted: boolean }>;
  stop: () => void;
  attach: (threadId: string) => Promise<void>;
  clearStreamingContent: () => void;
  clearToolEvents: () => void;
  // ADR-0080 — arm with the steering message's id before the PATCH so a
  // `done` that races in before the PATCH resolves still reconnects for a
  // genuine continuation (see consume()'s "done" branch). Does NOT touch
  // the live buffer by itself: the mainline case (steering drained by
  // preModelHook into the same ongoing stream) never breaks the stream at
  // all, so arming must be non-destructive or every steer would flash the
  // bubble for no reason.
  armSteeredContinuation: (id: string | null) => void;
  // Undo a reactive split if the PATCH turns out to have been rejected —
  // whether or not `done` had already raced in and frozen a segment.
  rollbackSteeredSegment: (id: string) => void;
};

// Tool names with a `call` event but no later `result` for that id, in call
// order. The single source of truth for "which tools are still running" —
// ToolList groups the same `tool_call`/`tool_result` pairs to render its
// own per-call status badges, so deriving the header label from the same
// events (instead of a second, separately-maintained id->name map) means
// the two can't drift apart as event handling evolves.
function activeToolNames(events: ToolEvent[]): string[] {
  const active = new Map<string, string>();
  for (const ev of events) {
    if (ev.phase === "call") active.set(ev.id, ev.name);
    else if (ev.phase === "result") active.delete(ev.id);
  }
  return [...active.values()];
}

function useRunActivity() {
  const activityRef = useRef<ReturnType<typeof pushActivity> | null>(null);

  const open = useCallback((initial: string) => {
    activityRef.current?.clear();
    activityRef.current = pushActivity(initial);
  }, []);

  const close = useCallback(() => {
    activityRef.current?.clear();
    activityRef.current = null;
  }, []);

  const setStatus = useCallback((label: string) => {
    activityRef.current?.set(label);
  }, []);

  const reportToolActivity = useCallback((events: ToolEvent[]) => {
    const active = activeToolNames(events);
    activityRef.current?.set(active[0] ? `Using ${active[0]}…` : "Thinking…");
    activityRef.current?.setInflightTools(active.length);
  }, []);

  useEffect(() => close, [close]);

  return { open, close, setStatus, reportToolActivity };
}

function useStreamingBuffer() {
  const [streamingContent, setStreamingContent] = useState("");
  const [thinkingContent, setThinkingContent] = useState("");
  const pendingTextRef = useRef("");
  const pendingThinkingRef = useRef("");
  const rafIdRef = useRef<number | null>(null);
  // Mirrors `streamingContent` for synchronous reads from long-running
  // closures (consume()'s "done" branch runs inside the same `consume`
  // invocation for a run's whole lifetime — its closure is fixed at the
  // point the run started, well before any deltas arrived, so reading the
  // `streamingContent` state variable directly there would see a stale
  // snapshot. The ref is updated at every state write below and read
  // instead wherever a split needs the *current* buffer, not the one at
  // closure-creation time.
  const streamingContentRef = useRef("");

  const flushPending = useCallback(() => {
    rafIdRef.current = null;
    if (pendingTextRef.current) {
      const delta = pendingTextRef.current;
      pendingTextRef.current = "";
      // Write the ref via plain assignment rather than inside the
      // setState updater — the updater isn't guaranteed to run
      // synchronously, so a split immediately after this call could still
      // observe a stale ref if the write happened only inside it.
      const next = streamingContentRef.current + delta;
      streamingContentRef.current = next;
      setStreamingContent(next);
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
    streamingContentRef.current = "";
    setStreamingContent("");
    setThinkingContent("");
  }, [cancelPendingFlush]);

  const clearStreamingContent = useCallback(() => {
    streamingContentRef.current = "";
    setStreamingContent("");
  }, []);

  const splitStreamingContent = useCallback(() => {
    const content = streamingContentRef.current + pendingTextRef.current;
    pendingTextRef.current = "";
    streamingContentRef.current = "";
    setStreamingContent("");
    return content;
  }, []);

  const restoreStreamingContent = useCallback((content: string) => {
    if (!content) return;
    const next = content + streamingContentRef.current;
    streamingContentRef.current = next;
    setStreamingContent(next);
  }, []);

  // Output-validator retry (ADR-0037) discarding a flagged completed reply
  // (see the "reset_text" StreamChunk in base.ts): drop whatever hasn't been
  // flushed yet so a flush scheduled just before this runs is a no-op (the
  // `if (pendingTextRef.current)` guard in flushPending short-circuits on
  // the now-empty string), then clear what's already rendered.
  const resetStreamingText = useCallback(() => {
    pendingTextRef.current = "";
    streamingContentRef.current = "";
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
    splitStreamingContent,
    restoreStreamingContent,
    resetStreamingText,
  };
}

// Single-transport agent run hook (ADR-0008): one POST to submit + one
// `EventSource` (under the hood) to subscribe. The hook keeps a stable
// surface for `ChatView` — `start`, `attach`, `stop`, `streaming`,
// `streamingContent`, etc. — even though the transport underneath collapsed
// from three legs (WS sidecar / SSE-POST / SSE-GET reattach) to one.
export function useSSE(onDone?: () => void): UnifiedHookResult<UseSSEState, UseSSECommands> {
  const [streaming, setStreaming] = useState(false);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  // Mirrors `toolEvents` for synchronous reads inside `consume()` (the
  // thinking_delta branch) without putting toolEvents into consume's
  // dependency array, which would recreate it on every tool event.
  const toolEventsRef = useRef<ToolEvent[]>([]);
  toolEventsRef.current = toolEvents;
  const [error, setError] = useState<string | null>(null);
  // Structured auth-failure surface: when set, ChatView renders a banner
  // that deep-links to /settings/credentials for the offending row.
  // Cleared on every new start()/attach().
  const [authError, setAuthError] = useState<AuthError>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadIdRef = useRef<string | null>(null);
  // ADR-0080 — id of the steering message currently armed for a possible
  // continuation break, or null. Set eagerly (before the steer PATCH
  // resolves) so a `done` that races in during that round trip still gets
  // caught; cleared the moment a `done` is actually observed.
  const steeredContinuationIdRef = useRef<string | null>(null);
  const [steeredSegments, setSteeredSegments] = useState<SteeredSegment[]>([]);
  const {
    open: openActivity,
    close: closeActivity,
    setStatus: setActivityStatus,
    reportToolActivity,
  } = useRunActivity();
  const {
    streamingContent,
    thinkingContent,
    appendText,
    appendThinking,
    flushPending,
    cancelPendingFlush,
    reset: resetBuffer,
    clearStreamingContent: clearStreamingContentBuffer,
    splitStreamingContent,
    restoreStreamingContent,
    resetStreamingText,
  } = useStreamingBuffer();

  // Clearing the live buffer in favor of the persisted message must also
  // drop any still-frozen steered segment from this run — both are
  // superseded by the same refetch (ChatView's finalizeRunFromServer).
  const clearStreamingContent = useCallback(() => {
    clearStreamingContentBuffer();
    setSteeredSegments([]);
  }, [clearStreamingContentBuffer]);

  // Abort the active EventSource on unmount so the server connection closes
  // and we don't call state setters on a dead component.
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const consume = useCallback(async (
    iterable: AsyncIterable<string>,
  ): Promise<boolean> => {
    for await (const raw of iterable) {
      let event: SSEEventType;
      try {
        event = JSON.parse(raw) as SSEEventType;
      } catch {
        continue;
      }
      if (event.type === "text_delta") {
        appendText(event.delta);
        setActivityStatus("Responding…");
      } else if (event.type === "reset_text") {
        resetStreamingText();
      } else if (event.type === "status") {
        const label = typeof event.label === "string" && event.label.trim().length > 0
          ? event.label
          : "Thinking…";
        setActivityStatus(label);
      } else if (event.type === "thinking_delta") {
        appendThinking(event.delta);
        if (activeToolNames(toolEventsRef.current).length === 0) setActivityStatus("Thinking…");
      } else if (event.type === "tool_call") {
        // Flush any buffered text before the tool event so the order on
        // screen matches the order on the wire.
        flushPending();
        setToolEvents((prev) => {
          const next = [...prev, { id: event.id, phase: "call" as const, name: event.name, payload: event.arguments }];
          reportToolActivity(next);
          return next;
        });
      } else if (event.type === "tool_result") {
        flushPending();
        setToolEvents((prev) => {
          const next = [...prev, { id: event.id, phase: "result" as const, name: event.name, payload: event.result }];
          reportToolActivity(next);
          return next;
        });
      } else if (event.type === "tool_progress") {
        // Doesn't flush pending text — a progress chunk from a still-running
        // tool call doesn't mark a text/tool ordering boundary the way a
        // call/result pair does.
        setToolEvents((prev) => [
          ...prev,
          { id: event.id, phase: "progress", name: event.name, payload: event.text },
        ]);
      } else if (event.type === "done") {
        flushPending();
        const pendingSteerId = steeredContinuationIdRef.current;
        steeredContinuationIdRef.current = null;
        if (pendingSteerId) {
          // ADR-0080 — this `done` landed while a steer was armed. In the
          // mainline case preModelHook already drained the steering into
          // this same stream and this is just the turn's real end; in the
          // rare edge case (steering during the final model call) a
          // continuation turn is starting server-side right now. Either
          // way, freeze what rendered so far under the steering message's
          // id and reconnect — a non-continuation reconnect resolves to an
          // immediate synthetic `done` (see the GET handler), so this
          // costs one cheap extra round trip rather than any visible gap.
          const frozen = splitStreamingContent();
          if (frozen) setSteeredSegments((segs) => [...segs, { id: pendingSteerId, content: frozen }]);
          return true;
        }
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
        return false;
      } else if (event.type === "error") {
        cancelPendingFlush();
        setStreaming(false);
        closeActivity();
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
        return false;
      }
    }
    return false;
  }, [appendText, appendThinking, cancelPendingFlush, closeActivity, flushPending, onDone, reportToolActivity, resetStreamingText, setActivityStatus, splitStreamingContent]);

  const start = useCallback(async (
    threadId: string,
    message: string,
    options?: StreamOptions,
    attachments?: ContentPart[],
    hotSince?: string | null,
    channels?: string[],
  ): Promise<{ accepted: boolean }> => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    threadIdRef.current = threadId;
    resetBuffer();
    setStreaming(true);
    setToolEvents([]);
    setError(null);
    setAuthError(null);
    // A fresh run must not inherit a stale arm/segment from whatever
    // thread this hook instance was last attached to.
    steeredContinuationIdRef.current = null;
    setSteeredSegments([]);
    openActivity("Sending…");

    try {
      // Command: register the run server-side. 202 = we own this turn; 409
      // = another tab/device owns it (caller re-queues, we still subscribe
      // so the user sees the in-flight turn's deltas render).
      const submit = await submitRun(threadId, message, ctrl.signal, options, attachments, hotSince, channels);

      // Query: subscribe to the run's chunk stream. Always opens the GET,
      // regardless of whether we got 202 or 409 — if 409 a run is already
      // in flight on the server and we want to observe it.
      let continuation = false;
      do {
        continuation = await consume(subscribeRun(threadId, ctrl.signal, options, continuation));
      } while (continuation);
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
      closeActivity();
    }
  }, [closeActivity, consume, openActivity, resetBuffer]);

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
    flushPending();
    setStreaming(false);
    // Keep streamingContent and thinkingContent visible until the next
    // start()/attach() — same pattern as the `done` branch in consume().
    closeActivity();
    abortRef.current?.abort();
    steeredContinuationIdRef.current = null;
    onDone?.();
  }, [closeActivity, flushPending, onDone]);

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
    resetBuffer();
    setStreaming(true);
    setToolEvents([]);
    setError(null);
    setAuthError(null);
    steeredContinuationIdRef.current = null;
    setSteeredSegments([]);
    openActivity("Reconnecting…");

    try {
      let continuation = false;
      do {
        continuation = await consume(subscribeRun(threadId, ctrl.signal, undefined, continuation));
      } while (continuation);
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
      closeActivity();
    }
  }, [closeActivity, consume, onDone, openActivity, resetBuffer]);

  // Called by the consumer after a refetch lands, so the streaming bubble
  // gets swapped for the persisted assistant message in a single render.
  const dismissAuthError = useCallback(() => { setAuthError(null); }, []);
  const armSteeredContinuation = useCallback((id: string | null) => {
    steeredContinuationIdRef.current = id;
  }, []);
  // Undo a reactive split from consume()'s "done" branch if the steer PATCH
  // turns out to have been rejected — whether or not `done` had already
  // raced in and frozen a segment under this id (see steerRun in
  // ChatView.tsx). If nothing was frozen yet, this just disarms.
  const rollbackSteeredSegment = useCallback((id: string) => {
    if (steeredContinuationIdRef.current === id) steeredContinuationIdRef.current = null;
    setSteeredSegments((segs) => {
      const match = segs.find((s) => s.id === id);
      if (!match) return segs;
      restoreStreamingContent(match.content);
      return segs.filter((s) => s.id !== id);
    });
  }, [restoreStreamingContent]);
  const clearToolEvents = useCallback(() => { setToolEvents([]); }, []);

  const state: UseSSEState = {
    streaming,
    streamingContent,
    thinkingContent,
    toolEvents,
    error,
    authError,
    steeredSegments,
  };
  const commands: UseSSECommands = {
    dismissAuthError,
    start,
    stop,
    attach,
    clearStreamingContent,
    clearToolEvents,
    armSteeredContinuation,
    rollbackSteeredSegment,
  };

  return {
    state,
    commands,
    streaming,
    streamingContent,
    thinkingContent,
    toolEvents,
    error,
    authError,
    steeredSegments,
    dismissAuthError,
    start,
    stop,
    attach,
    clearStreamingContent,
    clearToolEvents,
    armSteeredContinuation,
    rollbackSteeredSegment,
  };
}
