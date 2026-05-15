"use client";
import { useCallback, useEffect, useState } from "react";
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

  const handleDone = useCallback(() => {
    if (threadId) {
      api.threads.get(threadId).then((d) => {
        setMessages(d.messages);
        setHasMore(d.has_more);
      }).catch(console.error);
      onMessageSent();
    }
  }, [threadId, onMessageSent]);

  const { streaming, streamingContent, thinkingContent, toolEvents, error, start, stop, attach } = useSSE(handleDone);

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
        addNotice(`Session saved to memory. Starting fresh.`);
      } else {
        addNotice("Nothing to compact yet — send some messages first.");
      }
    } catch (err) {
      addNotice(`Compaction failed: ${String(err)}`);
    } finally {
      setCompacting(false);
    }
  }

  async function handleSubmit() {
    const msg = input.trim();
    if (!msg || !agentId) return;

    if (msg.toLowerCase() === "/new") {
      setInput("");
      await handleCompact();
      return;
    }

    if (!threadId) {
      setNotices([{ id: `notice-${Date.now()}`, text: sessionError ? `Session failed to load: ${sessionError}` : "Session is still loading, please try again." }]);
      return;
    }
    setInput("");
    const currentAttachments = attachments;
    setAttachments([]);

    // Optimistic message — include attachments so the user immediately sees
    // their pasted image / file in the bubble. The MessageBubble re-renders
    // ContentPart[] (the JSON form), so we mirror what gets persisted.
    const optimisticContent = currentAttachments.length
      ? JSON.stringify([{ type: "text" as const, text: msg }, ...currentAttachments])
      : msg;
    setMessages((p) => [
      ...p,
      { id: `opt-${Date.now()}`, role: "user", content: optimisticContent, created_at: new Date().toISOString() },
    ]);

    await start(
      threadId,
      msg,
      { filters: { include_tools: showTools, include_thinking: showThinking } },
      currentAttachments.length ? currentAttachments : undefined,
    );
  }

  return (
    <div className="flex flex-col h-full">
      <MessageList
        messages={messages}
        notices={notices}
        agentConfig={agentConfig}
        userProfile={userProfile}
        streamingContent={streaming ? streamingContent : undefined}
        thinkingContent={streaming ? thinkingContent : undefined}
        toolEvents={streaming ? toolEvents : undefined}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={loadOlder}
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
          compacting ||
          !!sessionLoading ||
          messagesLoading ||
          agentConfigLoading ||
          profileLoading
        }
        placeholder={
          compacting ? "Compacting session…" :
          sessionLoading ? "Loading session…" :
          messagesLoading ? "Loading chat history…" :
          agentConfigLoading ? "Loading agent…" :
          profileLoading ? "Loading profile…" :
          undefined
        }
      />
    </div>
  );
}
