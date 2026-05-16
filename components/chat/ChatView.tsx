"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, ContentPart, Message, UserProfile } from "@/api/types";
import { useSSE } from "@/hooks/useSSE";
import { useTrackLoading } from "@/lib/ui/loading";
import { ApprovalsBanner } from "@/components/proposals/ApprovalsBanner";
import { InputBar } from "./InputBar";
import { MessageList } from "./MessageList";

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
  const [messages, setMessages] = useState<Message[]>([]);
  const [notices, setNotices] = useState<SystemNotice[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ContentPart[]>([]);
  const [compacting, setCompacting] = useState(false);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [defaultAgent, setDefaultAgent] = useState<AgentConfig | null>(null);
  const [recentAgents, setRecentAgents] = useState<AgentConfig[]>([]);

  const addNotice = (text: string) =>
    setNotices((p) => [...p, { id: `notice-${Date.now()}`, text }]);

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

  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [profileLoading, setProfileLoading] = useState(true);
  const [agentConfigLoading, setAgentConfigLoading] = useState(false);

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

  // Forward declaration via ref so handleDone (defined first) can dequeue
  // and call back into the run-launching code (defined later).
  const drainQueueRef = useRef<() => void>(() => {});

  // Need clearStreamingContent before useSSE returns it. Use a ref so
  // handleDone (which is a dep of useSSE) isn't itself dependent on the
  // hook's return value.
  const clearStreamingRef = useRef<() => void>(() => {});

  const handleDone = useCallback(() => {
    if (threadId) {
      api.threads.get(threadId).then((d) => {
        // setMessages + clearStreamingContent batch into a single render
        // (React 18 auto-batching in microtasks), so the streaming bubble
        // and the persisted assistant bubble swap atomically — no gap, no
        // visual jump-back when the chat content briefly shrinks.
        setMessages(d.messages);
        setHasMore(d.has_more);
        clearStreamingRef.current();
      }).catch(console.error)
        .finally(() => {
          drainQueueRef.current();
        });
      onMessageSent();
    }
  }, [threadId, onMessageSent]);

  const { streaming, streamingContent, thinkingContent, toolEvents, error, start, stop, attach, clearStreamingContent } = useSSE(handleDone);
  clearStreamingRef.current = clearStreamingContent;

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
      return;
    }
    let cancelled = false;
    setMessagesLoading(true);
    // Clear stale state immediately so we don't briefly show another thread's
    // messages while the new fetch is in flight.
    setMessages([]);
    setHasMore(false);
    api.threads.get(threadId).then((d) => {
      if (cancelled) return;
      setMessages(d.messages);
      setHasMore(d.has_more);
    }).catch((err) => { if (!cancelled) console.error(err); })
      .finally(() => {
        if (cancelled) return;
        setMessagesLoading(false);
        // Attach to any in-flight run for THIS thread (no-op otherwise).
        attach(threadId).catch(() => { /* best-effort */ });
        // Drain anything the user queued while the session was loading.
        drainQueueRef.current();
      });
    return () => { cancelled = true; };
  }, [threadId, attach]);

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
    setMessages((p) => [
      ...p,
      { id: `opt-${Date.now()}`, role: "user", content: optimisticContent, created_at: new Date().toISOString() },
    ]);
    await start(
      threadId,
      text,
      { filters: { include_tools: showTools, include_thinking: showThinking } },
      atts.length ? atts : undefined,
    );
  }

  // Wire the deferred drain — see drainQueueRef declaration above.
  // Single source of truth for queue progression: pops one item and launches
  // it ONLY if the chat is in a ready state. Multiple callers (handleDone
  // after a run, handleCompact after compact, the message-load effect after
  // a session resolves) all funnel through this, but the readiness guard
  // means out-of-band invocations are safe no-ops.
  drainQueueRef.current = () => {
    if (streaming || compacting || !threadId) return;
    setQueue((q) => {
      if (q.length === 0) return q;
      const [next, ...rest] = q;
      // Fire the next run on a microtask so React's commit settles first.
      Promise.resolve().then(() => { void launchRun(next.text, next.attachments); });
      return rest;
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
        messages={messages}
        notices={notices}
        agentConfig={agentConfig}
        userProfile={userProfile}
        // streamingContent stays visible past `streaming=false` so the bubble
        // doesn't disappear before the refetch arrives. Cleared atomically in
        // handleDone via clearStreamingRef once the persisted message lands.
        streamingContent={streamingContent || undefined}
        thinkingContent={streaming ? thinkingContent : undefined}
        toolEvents={streaming ? toolEvents : undefined}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={loadOlder}
        queuedMessages={queue.map((q) => ({ id: q.id, text: q.text, attachmentCount: q.attachments.length }))}
        onRemoveQueued={removeQueued}
      />

      {error && (
        <div className="mx-4 mb-2 px-3 py-2 rounded bg-red-900/40 border border-red-700 text-red-300 text-xs max-h-48 overflow-y-auto">
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
              <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${gradientFor(defaultAgent.id)} flex items-center justify-center text-xl font-bold text-white select-none overflow-hidden ring-2 ring-accent/30 ring-offset-2 ring-offset-surface group-hover:ring-accent/50 transition-all`}>
                {defaultAgent.icon
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={defaultAgent.icon} alt={defaultAgent.name} className="w-full h-full object-cover" />
                  : defaultAgent.name.charAt(0).toUpperCase()}
              </div>
              <div className="text-center min-w-0 w-full">
                <div className="flex items-center justify-center gap-1.5">
                  <p className="text-base font-semibold text-zinc-100 truncate">{defaultAgent.name}</p>
                  <span className="text-[9px] uppercase tracking-wider px-1.5 py-px rounded text-accent bg-accent/15 border border-accent/30">default</span>
                </div>
                {defaultAgent.identity && (
                  <p className="text-xs text-zinc-400 mt-0.5 line-clamp-2 px-2">{defaultAgent.identity}</p>
                )}
              </div>
            </button>
          )}

          {/* Latest 3 others — small row below */}
          {recentAgents.length > 0 && (
            <div className="flex flex-col items-center gap-1.5">
              <p className="text-[10px] text-zinc-600 uppercase tracking-wider">Recent</p>
              <div className="flex gap-1.5 justify-center flex-wrap">
                {recentAgents.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => onSelectAgent?.(a.id)}
                    title={a.identity || a.name}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-border bg-surface-2 hover:bg-surface-3 hover:border-zinc-600 transition-colors text-left max-w-[150px]"
                  >
                    <div className={`w-6 h-6 shrink-0 rounded-md bg-gradient-to-br ${gradientFor(a.id)} flex items-center justify-center text-xs font-bold text-white select-none overflow-hidden`}>
                      {a.icon
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={a.icon} alt={a.name} className="w-full h-full object-cover" />
                        : a.name.charAt(0).toUpperCase()}
                    </div>
                    <p className="text-xs text-zinc-300 truncate">{a.name}</p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {!agentId && !defaultAgent && recentAgents.length === 0 && (
        <div className="mx-4 mb-2 px-3 py-2 rounded bg-surface-3 border border-border text-zinc-400 text-xs text-center">
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
