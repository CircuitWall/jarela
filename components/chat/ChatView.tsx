"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, ContentPart, Message, UserProfile } from "@/api/types";
import { useSSE } from "@/hooks/useSSE";
import { useAppContext } from "@/contexts/AppContext";
import { useTrackLoading } from "@/lib/ui/loading";
import { ApprovalsBanner } from "@/components/proposals/ApprovalsBanner";
import { InputBar } from "./InputBar";
import { MessageList } from "./MessageList";
import { useUnreadByAgent } from "@/lib/ui/toasts";

const GRADIENTS = [
  "from-violet-500 to-indigo-600",
  "from-blue-500 to-cyan-600",
  "from-emerald-500 to-teal-600",
  "from-orange-500 to-amber-600",
  "from-rose-500 to-pink-600",
  "from-fuchsia-500 to-purple-600",
];
function gradientFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(h) % GRADIENTS.length];
}

interface SystemNotice {
  id: string;
  text: string;
}

interface Props {
  threadId: string | null;
  agentId: string | null;
  sessionLoading?: boolean;
  sessionError?: string | null;
  showTools: boolean;
  showThinking: boolean;
  onMessageSent: () => void;
  onSelectAgent?: (agentId: string) => void;
}

export function ChatView({ threadId, agentId, sessionLoading, sessionError, showTools, showThinking, onMessageSent, onSelectAgent }: Props) {
  const { state } = useAppContext();
  const [messages, setMessages] = useState<Message[]>([]);
  const [notices, setNotices] = useState<SystemNotice[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ContentPart[]>([]);
  const [compacting, setCompacting] = useState(false);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [defaultAgent, setDefaultAgent] = useState<AgentConfig | null>(null);
  const [recentAgents, setRecentAgents] = useState<AgentConfig[]>([]);
  const unreadByAgent = useUnreadByAgent();
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
      api.agents.list().then((all) => {
        const def = all.find((a) => a.is_default) ?? null;
        const others = all
          .filter((a) => !a.is_default)
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          .slice(0, 3);
        setDefaultAgent(def);
        setRecentAgents(others);
      }).catch(console.error);
      return;
    }
    setRecentAgents([]);
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
    api.threads.get(threadId).then((d) => {
      if (cancelled) return;
      setMessages(d.messages);
      setHasMore(d.has_more);
      setHotSince(d.hot_since ?? null);
      setWarmSummary(d.warm_summary ?? null);
      setWarmSummaryBefore(d.warm_summary_before ?? null);
      setWarmSummaryComputedAt(d.warm_summary_computed_at ?? null);
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
  }, [threadId, loadingMore, hasMore, messages]);

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
        filters: { include_tools: showTools, include_thinking: showThinking },
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

  function removeQueued(id: string) {
    setQueue((q) => q.filter((m) => m.id !== id));
  }

  async function handleSubmit() {
    const msg = input.trim();
    if (!msg || !agentId) return;

    if (msg.toLowerCase() === "/new") {
      setInput("");
      await handleCompact();
      return;
    }

    if (sessionError) {
      setNotices([{ id: `notice-${Date.now()}`, text: `Session failed to load: ${sessionError}` }]);
      return;
    }

    setInput("");
    const currentAttachments = attachments;
    setAttachments([]);

    // Queue when ANY gating condition holds: a run is already in flight,
    // we're compacting, the session is still loading (no threadId yet), or
    // there are already items ahead in the queue. The drain triggers
    // (handleDone, handleCompact, the message-load effect) will fire it
    // when the gate clears. Sending immediately is reserved for the fully
    // ready state.
    const ready =
      !streaming && !compacting && !!threadId && queueRef.current.length === 0;
    if (!ready) {
      setQueue((q) => [...q, {
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        text: msg,
        attachments: currentAttachments,
      }]);
      return;
    }

    await launchRun(msg, currentAttachments);
  }

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
        queuedMessages={queue.map((q) => ({ id: q.id, text: q.text, attachmentCount: q.attachments.length }))}
        onRemoveQueued={removeQueued}
        hotSince={hotSince}
        warmSummary={warmSummary}
        warmSummaryBefore={warmSummaryBefore}
        warmSummaryComputedAt={warmSummaryComputedAt}
        onSetContextPin={setContextPin}
        streaming={streaming}
      />

      {error && (
        <div className="mx-4 mb-2 px-3 py-2 rounded bg-red-900/40 border border-red-700 text-red-700 dark:text-red-300 text-xs max-h-48 overflow-y-auto">
          <pre className="whitespace-pre-wrap break-all font-mono">{error}</pre>
        </div>
      )}

      {!agentId && (defaultAgent || recentAgents.length > 0) && (
        <div className="mx-4 mb-4 flex flex-col items-center gap-3">
          {/* Featured: the default agent — bigger, centered, with a subtle glow */}
          {defaultAgent && (
            <button
              onClick={() => onSelectAgent?.(defaultAgent.id)}
              className="group flex flex-col items-center gap-2 px-5 py-4 rounded-2xl border border-accent/40 bg-gradient-to-br from-accent/10 to-surface-2 hover:from-accent/15 hover:border-accent/60 transition-all w-[260px] shadow-lg shadow-accent/10"
            >
              <div className="relative">
                <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${gradientFor(defaultAgent.id)} flex items-center justify-center text-xl font-bold text-white select-none overflow-hidden ring-2 ring-accent/30 ring-offset-2 ring-offset-surface group-hover:ring-accent/50 transition-all`}>
                  {defaultAgent.icon
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={defaultAgent.icon} alt={defaultAgent.name} className="w-full h-full object-cover" />
                    : defaultAgent.name.charAt(0).toUpperCase()}
                </div>
                {(unreadByAgent.get(defaultAgent.id) ?? 0) > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[20px] h-[20px] px-1.5 rounded-full bg-rose-500 border-2 border-surface text-[11px] font-bold text-white flex items-center justify-center leading-none">
                    {(unreadByAgent.get(defaultAgent.id) ?? 0) > 9 ? "9+" : unreadByAgent.get(defaultAgent.id)}
                  </span>
                )}
              </div>
              <div className="text-center min-w-0 w-full">
                <div className="flex items-center justify-center gap-1.5">
                  <p className="text-base font-semibold text-fg truncate">{defaultAgent.name}</p>
                  <span className="text-[9px] uppercase tracking-wider px-1.5 py-px rounded text-accent bg-accent/15 border border-accent/30">default</span>
                </div>
                {defaultAgent.identity && (
                  <p className="text-xs text-fg-subtle mt-0.5 line-clamp-2 px-2">{defaultAgent.identity}</p>
                )}
              </div>
            </button>
          )}

          {/* Latest 3 others — small row below */}
          {recentAgents.length > 0 && (
            <div className="flex flex-col items-center gap-1.5">
              <p className="text-[10px] text-fg-faint uppercase tracking-wider">Recent</p>
              <div className="flex gap-1.5 justify-center flex-wrap">
                {recentAgents.map((a) => {
                  const n = unreadByAgent.get(a.id) ?? 0;
                  return (
                    <button
                      key={a.id}
                      onClick={() => onSelectAgent?.(a.id)}
                      title={a.identity || a.name}
                      className="relative flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-border bg-surface-2 hover:bg-surface-3 hover:border-border transition-colors text-left max-w-[150px]"
                    >
                      <div className={`w-6 h-6 shrink-0 rounded-md bg-gradient-to-br ${gradientFor(a.id)} flex items-center justify-center text-xs font-bold text-white select-none overflow-hidden`}>
                        {a.icon
                          // eslint-disable-next-line @next/next/no-img-element
                          ? <img src={a.icon} alt={a.name} className="w-full h-full object-cover" />
                          : a.name.charAt(0).toUpperCase()}
                      </div>
                      <p className="text-xs text-fg-muted truncate">{a.name}</p>
                      {n > 0 && (
                        <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-[16px] px-1 rounded-full bg-rose-500 border border-surface text-[10px] font-bold text-white flex items-center justify-center leading-none">
                          {n > 9 ? "9+" : n}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
      {!agentId && !defaultAgent && recentAgents.length === 0 && (
        <div className="mx-4 mb-2 px-3 py-2 rounded bg-surface-3 border border-border text-fg-subtle text-xs text-center">
          No agent selected — open the menu and pick an agent to start chatting.
        </div>
      )}

      <ApprovalsBanner agentId={agentId} />

      <InputBar
        value={input}
        onChange={setInput}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        onSubmit={handleSubmit}
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
        disabled={
          !agentId ||
          !!sessionError
        }
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
