"use client";
import { Settings } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppContext } from "@/contexts/AppContext";
import { useAgentSession } from "@/hooks/useAgentSession";
import { useEventNotifications } from "@/hooks/useEventNotifications";
import { api } from "@/api/client";
import type { AgentConfig } from "@/api/types";
import { ChatView } from "@/components/chat/ChatView";
import { MemoryPanel } from "@/components/memory/MemoryPanel";
import { ModelsPanel } from "@/components/models/ModelsPanel";
import { AgentsPanel } from "@/components/agents/AgentsPanel";
import { ProfilePanel } from "@/components/profile/ProfilePanel";
import { MCPPanel } from "@/components/mcp/MCPPanel";
import { IntegrationsPanel } from "@/components/integrations/IntegrationsPanel";
import { ScheduledTasksPanel } from "@/components/scheduled-tasks/ScheduledTasksPanel";
import { TopProgressBar } from "@/components/ui/TopProgressBar";
import { NotificationStatus } from "@/components/ui/NotificationStatus";
import { Toaster } from "@/components/ui/Toaster";
import { clearUnread, useUnreadCount } from "@/lib/ui/toasts";
import { GearPanel } from "./GearPanel";

export function AppShell() {
  const { state, dispatch } = useAppContext();
  const { threadId, loading: sessionLoading, error: sessionError } = useAgentSession(state.activeAgentId);

  const [showGear, setShowGear] = useState(false);
  const [showTools, setShowTools] = useState(true);
  const [showThinking, setShowThinking] = useState(true);

  const unreadCount = useUnreadCount();

  // Cache agent id → name for notification titles. Refreshed on agent CRUD.
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  useEffect(() => { api.agents.list().then(setAgents).catch(() => {}); }, []);
  const agentsRef = useRef<AgentConfig[]>([]);
  agentsRef.current = agents;

  // Track current view so we can suppress notifications for the agent in focus.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Stable callback references — without these, AppShell re-renders (e.g. on
  // gear toggle, unread counter clearing) hand ChatView fresh function
  // identities. ChatView's hooks re-derive cascading useCallbacks (handleDone
  // → useSSE.consume → useSSE.attach), and effects keyed on `attach` re-fire,
  // forcing a message refetch + chat-window scroll. Stable refs break the cascade.
  const onMessageSent = useCallback(() => {}, []);
  const onSelectAgent = useCallback(
    (id: string) => { dispatch({ type: "SET_AGENT", agentId: id }); },
    [dispatch],
  );

  // Click on an OS Web Notification → useEventNotifications fires a custom
  // event; handle it here to switch to the relevant agent's chat.
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<{ agentId?: string }>).detail;
      if (detail?.agentId) {
        dispatch({ type: "SET_AGENT", agentId: detail.agentId });
        dispatch({ type: "SET_TAB", tab: "chat" });
      }
    }
    window.addEventListener("langgui:focus-agent", handler);
    return () => window.removeEventListener("langgui:focus-agent", handler);
  }, [dispatch]);

  useEventNotifications({
    shouldNotify: (ev) => {
      // Scheduled task firings ALWAYS notify. The user explicitly set them up
      // out-of-band — "remind me at 3pm", "every weekday morning". Even if
      // they happen to be on that agent's chat, they may not be actively
      // reading right when the task fires; the whole point is the ping.
      if (ev.type === "task_completed") return true;

      // For ordinary run completions (the agent finished a turn the user
      // just sent), suppress only when the user is actively reading that
      // exact chat — the new message is already on screen.
      //
      // Otherwise notify in either of two cases:
      //   1. The PWA isn't focused (background tab, minimized, focused on
      //      another app). Detected via document.hidden + !hasFocus().
      //   2. The PWA IS focused but the user is on a different agent / a
      //      different tab inside the app (Memory, Tasks, Models, …).
      const pwaUnfocused =
        typeof document !== "undefined" &&
        (document.hidden || !document.hasFocus());

      const evAgentId = ev.agent_id;
      const onSameAgentChat =
        stateRef.current.activeTab === "chat" &&
        evAgentId !== null &&
        evAgentId === stateRef.current.activeAgentId;

      return pwaUnfocused || !onSameAgentChat;
    },
    resolveAgentName: (agentId) => {
      if (!agentId) return "LangGUI";
      const a = agentsRef.current.find((x) => x.id === agentId);
      return a?.name ?? "LangGUI";
    },
  });

  return (
    <div className="h-screen h-[100dvh] flex flex-col bg-surface text-zinc-100 overflow-hidden">
      <TopProgressBar />
      <NotificationStatus />
      <Toaster />
      <header
        className="flex items-center px-4 border-b border-border bg-surface-2 shrink-0 pt-safe"
        style={{ height: "calc(3rem + env(safe-area-inset-top))" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.svg" alt="LangGUI" className="h-6 select-none" />
        <button
          onClick={() => { setShowGear((v) => !v); clearUnread(); }}
          className={`ml-auto relative p-2 rounded transition-colors ${showGear ? "text-zinc-100 bg-surface-3" : "text-zinc-500 hover:text-zinc-300 hover:bg-surface-3/50"}`}
          title={unreadCount > 0 ? `${unreadCount} new ${unreadCount === 1 ? "alert" : "alerts"}` : "Menu"}
        >
          <Settings size={16} />
          {unreadCount > 0 && (
            <span className="absolute top-1 right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-rose-500 border border-surface-2 text-[9px] font-bold text-white flex items-center justify-center leading-none animate-pulse">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>
      </header>

      <div className="flex-1 relative overflow-hidden">
        {state.activeTab === "chat" && (
          <ChatView
            key={state.activeAgentId ?? "no-agent"}
            threadId={threadId}
            agentId={state.activeAgentId}
            sessionLoading={sessionLoading}
            sessionError={sessionError}
            showTools={showTools}
            showThinking={showThinking}
            onMessageSent={onMessageSent}
            onSelectAgent={onSelectAgent}
          />
        )}
        {state.activeTab === "agents" && <AgentsPanel />}
        {state.activeTab === "memory" && <MemoryPanel />}
        {state.activeTab === "models" && <ModelsPanel />}
        {state.activeTab === "mcp" && <MCPPanel />}
        {state.activeTab === "integrations" && <IntegrationsPanel />}
        {state.activeTab === "tasks" && <ScheduledTasksPanel />}
        {state.activeTab === "profile" && <ProfilePanel />}

        {showGear && (
          <div className="absolute inset-0 bg-black/40 z-10" onClick={() => setShowGear(false)} />
        )}

        {showGear && (
          <GearPanel
            activeTab={state.activeTab}
            agentId={state.activeAgentId}
            showTools={showTools}
            showThinking={showThinking}
            onClose={() => setShowGear(false)}
            onAgentChange={(agentId) => dispatch({ type: "SET_AGENT", agentId })}
            onSetTab={(tab) => {
              dispatch({ type: "SET_TAB", tab });
              setShowGear(false);
            }}
            onShowToolsChange={setShowTools}
            onShowThinkingChange={setShowThinking}
          />
        )}
      </div>
    </div>
  );
}
