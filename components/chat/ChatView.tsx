"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, ContentPart, Message, UserProfile } from "@/api/types";
import { useSSE } from "@/hooks/useSSE";
import { useAppContext } from "@/contexts/AppContext";
import { useTrackLoading } from "@/lib/ui/loading";
import { reportError } from "@/lib/ui/error-message";
import { ApprovalsBanner } from "@/components/proposals/ApprovalsBanner";
import { InputBar } from "./InputBar";
import { MessageList } from "./MessageList";

interface SystemNotice {
  id: string;
  text: string;
}

interface Props {
  threadId: string | null;
  agentId: string | null;
  sessionLoading?: boolean;
  sessionError?: string | null;
  onMessageSent: () => void;
}

export function ChatView({ threadId, agentId, sessionLoading, sessionError, onMessageSent }: Props) {
  const { state } = useAppContext();
  const [messages, setMessages] = useState<Message[]>([]);
  const [notices, setNotices] = useState<SystemNotice[]>([]);
  const [attachments, setAttachments] = useState<ContentPart[]>([]);
  const [compacting, setCompacting] = useState(false);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [profileLoading, setProfileLoading] = useState(true);
  const [agentConfigLoading, setAgentConfigLoading] = useState(false);
  // ADR-0042 — explicit context boundary + persisted warm summary. NULL on
  // threads with no pin (fall back to the agent's history_window_hours
  // default); a timestamp when the user has chosen where the line sits.
  const [hotSince, setHotSince] = useState<string | null>(null);
  const [warmSummary, setWarmSummary] = useState<string | null>(null);
  const [warmSummaryBefore, setWarmSummaryBefore] = useState<string | null>(null);
  const [warmSummaryComputedAt, setWarmSummaryComputedAt] = useState<string | null>(null);
  // Thread-level effective context window cap, used as the ContextUsageBar
  // baseline. Re-fetched on every thread load alongside hot_since / warm
  // summary state so a model swap is reflected immediately.
  const [contextWindowTokens, setContextWindowTokens] = useState<number | null>(null);

  const addNotice = (text: string) =>
    setNotices((p) => [...p, { id: `notice-${Date.now()}`, text }]);

  // Append-with-dedupe. After a run finishes, two independent code paths can
  // both fetch the freshly-persisted user+assistant rows and append them:
  //   1) handleDone (driven by the SSE `done` event for the local run), and
  //   2) the `jarela:thread-updated` window listener (driven by the
  //      cross-device events bus notification for the same run).
  // The streaming-ref guard in (2) bails while a local run is in flight, but
  // the notification can arrive in the same micro-window where streaming has
  // just flipped to false, slipping past the guard. Without dedupe, both
  // appends land and every newly-persisted message gets a duplicate React
  // key. Dedupe by id at the append site so either ordering converges to the
  // same list.
  function appendUnique(prev: Message[], incoming: Message[]): Message[] {
    if (incoming.length === 0) return prev;
    const seen = new Set(prev.map((m) => m.id));
    const fresh = incoming.filter((m) => !seen.has(m.id));
    return fresh.length === 0 ? prev : prev.concat(fresh);
  }

  useEffect(() => {
    setProfileLoading(true);
    api.profile.get().then(setUserProfile).catch(console.error).finally(() => setProfileLoading(false));
  }, []);

  useEffect(() => {
    if (!agentId) {
      setAgentConfig(null);
      setAgentConfigLoading(false);
      return;
    }
    setAgentConfigLoading(true);
    api.agents.get(agentId).then(setAgentConfig).catch(console.error).finally(() => setAgentConfigLoading(false));
  }, [agentId]);

  // FIFO queue of messages the user typed while a run was already streaming.
  // The chat input stays unblocked; we drain this queue after each run finishes.
  interface QueuedMessage {
    id: string;
    text: string;
    attachments: ContentPart[];
  }
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const queueRef = useRef<QueuedMessage[]>([]);
  queueRef.current = queue;

  // Mirror messages in a ref so handleDone can read the latest tail
  // without re-creating itself on every render (which would cascade
  // into useSSE deps and re-bind the streaming consumer per keystroke).
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  // Forward declaration via ref so handleDone (defined first) can dequeue
  // and call back into the run-launching code (defined later).
  const drainQueueRef = useRef<() => void>(() => {});

  // Need clearStreamingContent before useSSE returns it. Use a ref so
  // handleDone (which is a dep of useSSE) isn't itself dependent on the
  // hook's return value.
  const clearStreamingRef = useRef<() => void>(() => {});

  // When the next user turn came from a voice transcription, we arm this
  // flag so handleDone can fire a `jarela:speak-message` event at the new
  // assistant message id and the bubble auto-plays the TTS reply once.
  const pendingAutoSpeakRef = useRef(false);

  const handleDone = useCallback(() => {
    if (!threadId) return;
    // Forward-fetch only the messages persisted after our newest known one.
    // Typically two rows (user + assistant) instead of the full 50-row page,
    // so handleDone is O(turn) instead of O(thread). Falls back to full
    // reload if we somehow have no anchor (fresh thread, race).
    //
    // Anchor on the last *persisted* row, never an `opt-*` optimistic. The
    // optimistic's created_at is from the client clock; if it skews ahead of
    // the server, `after: anchor` would skip the just-persisted user row.
    const cur = messagesRef.current.filter((m) => !m.id.startsWith("opt-"));
    const anchor = cur.length > 0 ? cur[cur.length - 1].created_at : undefined;
    const fetchPromise = anchor
      ? api.threads.get(threadId, { after: anchor })
      : api.threads.get(threadId);
    fetchPromise.then((d) => {
      // setMessages + clearStreamingContent batch into a single render
      // (React 18 auto-batching in microtasks), so the streaming bubble
      // and the persisted assistant bubble swap atomically — no gap, no
      // visual jump-back when the chat content briefly shrinks.
      if (anchor) {
        // Drop optimistic user bubbles before appending — their `opt-*` ids
        // don't match the server-assigned ids of the persisted rows, so
        // id-only dedupe in appendUnique would leave both copies and the
        // user's message would render twice.
        setMessages((prev) => appendUnique(prev.filter((m) => !m.id.startsWith("opt-")), d.messages));
      } else {
        setMessages(d.messages);
        setHasMore(d.has_more);
      }
      // The thread metadata is spread on every GET, so the warm summary the
      // run just (re)computed lands here — chat card refreshes without a
      // second round-trip.
      setHotSince(d.hot_since ?? null);
      setWarmSummary(d.warm_summary ?? null);
      setWarmSummaryBefore(d.warm_summary_before ?? null);
      setWarmSummaryComputedAt(d.warm_summary_computed_at ?? null);
      setContextWindowTokens(d.context_window_tokens ?? null);
      clearStreamingRef.current();
      if (pendingAutoSpeakRef.current) {
        pendingAutoSpeakRef.current = false;
        // Find the newest assistant message and dispatch a speak event.
        // MessageBubble listens for its own id and triggers TTS play.
        const latest = [...d.messages].reverse().find((m) => m.role === "assistant" && m.id);
        if (latest?.id && typeof window !== "undefined") {
          // Defer to after the next render so the bubble exists in the DOM.
          requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent("jarela:speak-message", { detail: { messageId: latest.id } }));
          });
        }
      }
    }).catch(console.error)
      .finally(() => {
        drainQueueRef.current();
      });
    onMessageSent();
  }, [threadId, onMessageSent]);

  const { streaming, streamingContent, thinkingContent, toolEvents, error, start, stop, attach, clearStreamingContent } = useSSE(handleDone);
  clearStreamingRef.current = clearStreamingContent;

  // Surface session-load and stream errors as toasts instead of
  // disabling the input or rendering an inline red banner. Toasts are
  // dismissible, dedupe-by-id, and carry the Report path. The chat
  // stays interactive so the user can retry without reloading.
  const lastSessionErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionError) { lastSessionErrorRef.current = null; return; }
    if (lastSessionErrorRef.current === sessionError) return;
    lastSessionErrorRef.current = sessionError;
    reportError({
      error: sessionError,
      fallbackTitle: "Couldn't load session",
      summary: "The agent's thread didn't load. Retry by re-selecting the agent.",
      context: { agent_id: agentId, panel: "chat", action: "session.load" },
    });
  }, [sessionError, agentId]);

  const lastStreamErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!error) { lastStreamErrorRef.current = null; return; }
    if (lastStreamErrorRef.current === error) return;
    lastStreamErrorRef.current = error;
    reportError({
      error,
      fallbackTitle: "Chat stream error",
      context: { agent_id: agentId, thread_id: threadId, panel: "chat", action: "stream" },
    });
  }, [error, agentId, threadId]);

  // Mirror `streaming` in a ref so the cross-device sync listener below can
  // bail out without re-binding on every transport state change.
  const streamingRef = useRef(false);
  streamingRef.current = streaming;

  // Cross-device thread sync. When ANOTHER client (iOS PWA, bridge, scheduled
  // task) appends to this thread, the server publishes a notification on the
  // events bus. `useEventNotifications` dispatches a `jarela:thread-updated`
  // window event for every such ping. If it matches the thread we're viewing
  // and we're not currently the source of the run (no local stream in flight),
  // forward-fetch new messages so the chat list updates without a manual
  // page refresh.
  useEffect(() => {
    if (!threadId) return;
    function handler(e: Event) {
      const detail = (e as CustomEvent<{ thread_id: string }>).detail;
      if (!detail || detail.thread_id !== threadId) return;
      // The local run's own handleDone path already refetches — skip to
      // avoid double-fetching while a turn is mid-stream on this device.
      if (streamingRef.current) return;
      const cur = messagesRef.current;
      const anchor = cur.length > 0 ? cur[cur.length - 1].created_at : undefined;
      const fetchPromise = anchor
        ? api.threads.get(threadId, { after: anchor })
        : api.threads.get(threadId);
      fetchPromise.then((d) => {
        if (anchor) {
          if (d.messages.length === 0) return;
          setMessages((prev) => appendUnique(prev, d.messages));
        } else {
          setMessages(d.messages);
          setHasMore(d.has_more);
        }
        // Cross-device path: another client may have moved the boundary or
        // recomputed the summary. Refresh both unconditionally.
        setHotSince(d.hot_since ?? null);
        setWarmSummary(d.warm_summary ?? null);
        setWarmSummaryBefore(d.warm_summary_before ?? null);
        setWarmSummaryComputedAt(d.warm_summary_computed_at ?? null);
        setContextWindowTokens(d.context_window_tokens ?? null);
      }).catch(console.error);
    }
    window.addEventListener("jarela:thread-updated", handler);
    return () => window.removeEventListener("jarela:thread-updated", handler);
  }, [threadId]);

  // Surface every long-running task in the top progress bar.
  useTrackLoading(!!sessionLoading);
  useTrackLoading(streaming);
  useTrackLoading(compacting);
  useTrackLoading(loadingMore);
  useTrackLoading(messagesLoading);
  useTrackLoading(agentConfigLoading);

  useEffect(() => {
    if (!threadId) {
      setMessages([]);
      setNotices([]);
      setHasMore(false);
      setMessagesLoading(false);
      setHotSince(null);
      setWarmSummary(null);
      setWarmSummaryBefore(null);
      setWarmSummaryComputedAt(null);
      setContextWindowTokens(null);
      return;
    }
    let cancelled = false;
    setMessagesLoading(true);
    // Clear stale state immediately so we don't briefly show another thread's
    // messages while the new fetch is in flight.
    setMessages([]);
    setHasMore(false);
    setHotSince(null);
    setWarmSummary(null);
    setWarmSummaryBefore(null);
    setWarmSummaryComputedAt(null);
    setContextWindowTokens(null);
    api.threads.get(threadId).then((d) => {
      if (cancelled) return;
      setMessages(d.messages);
      setHasMore(d.has_more);
      setHotSince(d.hot_since ?? null);
      setWarmSummary(d.warm_summary ?? null);
      setWarmSummaryBefore(d.warm_summary_before ?? null);
      setWarmSummaryComputedAt(d.warm_summary_computed_at ?? null);
      setContextWindowTokens(d.context_window_tokens ?? null);
    }).catch((err) => { if (!cancelled) console.error(err); })
      .finally(() => {
        if (cancelled) return;
        setMessagesLoading(false);
        // Attach to any in-flight run for THIS thread. attach() now sets
        // streaming=true optimistically and signals completion via onDone
        // (which drains the queue), so we MUST NOT fire drainQueueRef here —
        // doing so would race against attach's optimistic gate and launch
        // a duplicate run that the server rejects.
        attach(threadId).catch(() => { /* best-effort */ });
      });
    return () => { cancelled = true; };
  }, [threadId, attach]);

  // ADR-0042. Move the user's boundary line. Optimistic update so the chat
  // chrome (boundary divider + summary card) reacts instantly; PATCH then
  // confirms server-side. Boundary moves invalidate the cached summary —
  // we clear it locally too so the UI shows a placeholder until the next
  // run refreshes it.
  const setContextPin = useCallback(async (next: string | null) => {
    if (!threadId) return;
    setHotSince(next);
    if (warmSummaryBefore !== next) {
      setWarmSummary(null);
      setWarmSummaryBefore(null);
      setWarmSummaryComputedAt(null);
    }
    try {
      const updated = await api.threads.setContextPin(threadId, next);
      // Resync from server in case of cross-device drift between optimistic
      // local update and server-confirmed state.
      setHotSince(updated.hot_since);
      setWarmSummary(updated.warm_summary);
      setWarmSummaryBefore(updated.warm_summary_before);
      setWarmSummaryComputedAt(updated.warm_summary_computed_at);
    } catch (err) {
      console.error("setContextPin failed", err);
    }
  }, [threadId, warmSummaryBefore]);

  const loadOlder = useCallback(async () => {
    if (!threadId || loadingMore || !hasMore || messages.length === 0) return;
    setLoadingMore(true);
    try {
      const oldest = messages[0].created_at;
      const d = await api.threads.get(threadId, { before: oldest, limit: 50 });
      setMessages((prev) => [...d.messages, ...prev]);
      setHasMore(d.has_more);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingMore(false);
    }
    // Depend on `messages.length` rather than the array identity so streaming
    // appends don't recreate this callback (which would churn MessageList's
    // onLoadMore prop on every text_delta).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, loadingMore, hasMore, messages.length]);

  async function handleCompact() {
    if (!agentId) return;
    setCompacting(true);
    try {
      const result = await api.agents.compact(agentId);
      setMessages([]);
      setNotices([]);
      if (result.compacted) {
        addNotice(`Session saved to memory (${result.message_count} msgs, ~${Math.round((result.context_chars||0)/1000)}k chars). Starting fresh.`);
      } else {
        addNotice("Nothing to compact yet — send some messages first.");
      }
    } catch (err) {
      addNotice(`Compaction failed: ${String(err)}`);
    } finally {
      setCompacting(false);      // Drain anything queued while compaction was running.
      drainQueueRef.current();    }
  }

  // Actually fire a run for one message. Used both by direct submit (when
  // idle) and by drain-from-queue (after a previous run finishes).
  async function launchRun(text: string, atts: ContentPart[]) {
    if (!threadId) return;
    const optimisticContent = atts.length
      ? JSON.stringify([{ type: "text" as const, text }, ...atts])
      : text;
    const optId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setMessages((p) => [
      ...p,
      { id: optId, role: "user", content: optimisticContent, created_at: new Date().toISOString() },
    ]);
    const { accepted } = await start(
      threadId,
      text,
      {
        filters: { include_tools: true, include_thinking: true },
        ui_experience_mode: state.experienceMode,
      },
      atts.length ? atts : undefined,
      hotSince,
    );
    if (!accepted) {
      // The server rejected this submission because another run was already
      // in flight for this thread (second tab, another device). We just
      // attached to the existing run's broadcast for the live deltas. Roll
      // back the optimistic user bubble and re-queue this message so the
      // drain after the in-flight run's `done` resubmits it cleanly.
      setMessages((p) => p.filter((m) => m.id !== optId));
      setQueue((q) => [
        {
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          text,
          attachments: atts,
        },
        ...q,
      ]);
    }
  }

  // Wire the deferred drain — see drainQueueRef declaration above.
  // Single source of truth for queue progression: when the chat is ready,
  // flush the ENTIRE queue as a single agent turn. Multiple queued user
  // messages get merged into one prompt (joined by a blank line) with all
  // their attachments concatenated, so the agent sees one coherent turn
  // instead of N round-trips. Multiple callers (handleDone after a run,
  // handleCompact after compact, the message-load effect after a session
  // resolves) all funnel through this; the readiness guard makes
  // out-of-band invocations safe no-ops.
  drainQueueRef.current = () => {
    if (streaming || compacting || !threadId) return;
    setQueue((q) => {
      if (q.length === 0) return q;
      const text = q.map((m) => m.text).join("\n\n");
      const atts = q.flatMap((m) => m.attachments);
      // Fire on a microtask so React's commit settles first.
      Promise.resolve().then(() => { void launchRun(text, atts); });
      return [];
    });
  };

  const removeQueued = useCallback((id: string) => {
    setQueue((q) => q.filter((m) => m.id !== id));
  }, []);

  // Resend a previously-sent user prompt as a new turn. Mirrors handleSubmit's
  // ready/queue gating so retries during an in-flight run behave the same as
  // typing a new message: they queue and drain. Does NOT delete the original
  // message — the user can clean up the thread manually if they want.
  //
  // `launchRun` is a plain function re-created each render; we read it
  // through a ref to keep this callback stable (otherwise MessageList sees
  // a fresh onRetryMessage on every streaming delta).
  const launchRunRef = useRef(launchRun);
  launchRunRef.current = launchRun;
  const handleRetryMessage = useCallback((text: string, atts: ContentPart[]) => {
    const msg = text.trim();
    if (!msg || !agentId) return;
    const ready =
      !streaming && !compacting && !!threadId && queueRef.current.length === 0;
    if (ready) {
      void launchRunRef.current(msg, atts);
      return;
    }
    setQueue((q) => [...q, {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text: msg,
      attachments: atts,
    }]);
  }, [agentId, streaming, compacting, threadId]);

  // Default Send / Enter. Send-when-idle, STEER-when-streaming.
  // Steer = prepend message to queue and abort the current run; the existing
  // handleDone → drainQueueRef machinery picks the prepended item up first
  // (merged ahead of any earlier queued items) once the abort settles.
  async function handleSubmit(rawInput: string) {
    let msg = rawInput.trim();
    if (!msg || !agentId) return;

    if (msg.toLowerCase() === "/new") {
      await handleCompact();
      return;
    }

    // /btw is intent flavor — strip the prefix so the agent never sees it.
    // The default handleSubmit path already steers when streaming and sends
    // when idle, so the prefix doesn't need to change routing.
    if (msg.toLowerCase().startsWith("/btw ")) {
      msg = msg.slice(5).trim();
      if (!msg) return;
    }

    const currentAttachments = attachments;
    setAttachments([]);

    const ready =
      !streaming && !compacting && !!threadId && queueRef.current.length === 0;
    if (ready) {
      await launchRun(msg, currentAttachments);
      return;
    }

    // Not ready: STEER. Prepend so the user's redirect goes to the front of
    // the merged drain turn. Abort the in-flight run (if any) — the existing
    // drainQueueRef wiring will fire after handleDone resolves the abort.
    setQueue((q) => [
      {
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        text: msg,
        attachments: currentAttachments,
      },
      ...q,
    ]);
    if (streaming) stop();
  }

  // ⌘/Ctrl+Enter — explicit "queue this turn" path. Always appends; never
  // aborts. When idle and the queue is empty there's nothing to wait behind,
  // so we just send normally (the modifier is redundant in that case).
  async function handleQueue(rawInput: string) {
    const msg = rawInput.trim();
    if (!msg || !agentId) return;

    // /new and /btw have stronger semantics than the queue modifier — defer
    // to handleSubmit so the prefix is parsed and routed correctly.
    if (msg.toLowerCase() === "/new" || msg.toLowerCase().startsWith("/btw ")) {
      await handleSubmit(rawInput);
      return;
    }

    const currentAttachments = attachments;
    setAttachments([]);

    const ready =
      !streaming && !compacting && !!threadId && queueRef.current.length === 0;
    if (ready) {
      await launchRun(msg, currentAttachments);
      return;
    }

    setQueue((q) => [...q, {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text: msg,
      attachments: currentAttachments,
    }]);
  }

  // Shallow projection for MessageList: keep prop identity stable so the
  // queued-bubble subtree doesn't re-reconcile on every streaming delta.
  const queuedMessages = useMemo(
    () => queue.map((q) => ({ id: q.id, text: q.text, attachmentCount: q.attachments.length })),
    [queue],
  );

  return (
    <div className="flex flex-col h-full">
      <MessageList
        threadId={threadId}
        messages={messages}
        notices={notices}
        agentConfig={agentConfig}
        userProfile={userProfile}
        // streamingContent stays visible past `streaming=false` so the bubble
        // doesn't disappear before the refetch arrives. Cleared atomically in
        // handleDone via clearStreamingRef once the persisted message lands.
        streamingContent={streamingContent || undefined}
        // Keep the live thinking line visible past `streaming=false` so a
        // user who's still reading isn't yanked out mid-sentence. useSSE
        // clears thinkingContent on the next start()/attach().
        thinkingContent={thinkingContent || undefined}
        toolEvents={streaming ? toolEvents : undefined}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={loadOlder}
        queuedMessages={queuedMessages}
        onRemoveQueued={removeQueued}
        hotSince={hotSince}
        warmSummary={warmSummary}
        warmSummaryBefore={warmSummaryBefore}
        warmSummaryComputedAt={warmSummaryComputedAt}
        onSetContextPin={setContextPin}
        streaming={streaming}
        contextWindowTokens={contextWindowTokens}
        onRetryMessage={handleRetryMessage}
      />

      <ApprovalsBanner agentId={agentId} />

      <InputBar
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        onSubmit={handleSubmit}
        onQueue={handleQueue}
        onStop={stop}
        streaming={streaming}
        voiceEnabled={!!agentConfig?.voice_enabled}
        agentId={agentId}
        onVoiceTranscript={(text) => {
          const msg = text.trim();
          if (!msg || !agentId) return;
          if (agentConfig?.voice_auto_speak !== false) {
            pendingAutoSpeakRef.current = true;
          }
          // Same gating as handleSubmit \u2014 queue when a run is in flight or
          // the session isn't fully loaded; otherwise launch immediately.
          const ready =
            !streaming && !compacting && !!threadId && queueRef.current.length === 0;
          if (!ready) {
            setQueue((q) => [...q, {
              id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              text: msg,
              attachments: [],
            }]);
          } else {
            void launchRun(msg, []);
          }
        }}
        disabled={!agentId}
        placeholder={
          compacting ? "Compacting session\u2026 your messages will queue" :
          sessionLoading ? "Loading session\u2026 your messages will queue" :
          messagesLoading ? "Loading chat history…" :
          agentConfigLoading ? "Loading agent…" :
          profileLoading ? "Loading profile…" :
          undefined
        }
      />
    </div>
  );
}
