"use client";
import { Menu } from "lucide-react";
import { Activity, useCallback, useEffect, useRef, useState } from "react";
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
import { BridgesPanel } from "@/components/bridges/BridgesPanel";
import { TopProgressBar } from "@/components/ui/TopProgressBar";
import { NotificationStatus } from "@/components/ui/NotificationStatus";
import { CryptoFallbackBanner } from "@/components/ui/CryptoFallbackBanner";
import { Toaster } from "@/components/ui/Toaster";
import { clearUnreadForAgent, useUnreadCount } from "@/lib/ui/toasts";
import { GearPanel } from "./GearPanel";

export function AppShell() {
  const { state, dispatch } = useAppContext();
  const { threadId, loading: sessionLoading, error: sessionError } = useAgentSession(state.activeAgentId);

  const [showGear, setShowGear] = useState(false);
  const [showTools, setShowTools] = useState(true);
  const [showThinking, setShowThinking] = useState(true);

  // Lazy-mount tabs on first visit, then keep them mounted via <Activity> so
  // state survives subsequent switches. Without this, opening the app forces
  // React to render and commit all 8 panel trees up front — Safari (esp. iOS
  // PWA) takes long enough on that synchronous commit that the initial
  // agents fetch in this very component visibly stalls.
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(
    () => new Set([state.activeTab]),
  );
  useEffect(() => {
    setMountedTabs((prev) => prev.has(state.activeTab) ? prev : new Set(prev).add(state.activeTab));
  }, [state.activeTab]);

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
    window.addEventListener("jarela:focus-agent", handler);
    return () => window.removeEventListener("jarela:focus-agent", handler);
  }, [dispatch]);

  // When the user is actively viewing an agent's chat, drain that agent's
  // unread bucket. This keeps the per-agent breakdown honest: badges only
  // count notifications the user hasn't yet seen in context.
  useEffect(() => {
    if (state.activeTab === "chat" && state.activeAgentId) {
      clearUnreadForAgent(state.activeAgentId);
    }
  }, [state.activeTab, state.activeAgentId]);

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
      if (!agentId) return "Jarela";
      const a = agentsRef.current.find((x) => x.id === agentId);
      return a?.name ?? "Jarela";
    },
    resolveAgentIcon: (agentId) => {
      if (!agentId) return null;
      const a = agentsRef.current.find((x) => x.id === agentId);
      return a?.icon ?? null;
    },
  });

  return (
    <div className="h-screen h-[100dvh] flex flex-col bg-surface text-zinc-100 overflow-hidden">
      <TopProgressBar />
      <CryptoFallbackBanner />
      <NotificationStatus />
      <Toaster />
      <header
        className="flex items-center px-4 border-b border-border bg-surface-2 shrink-0"
        style={{
          // Extra 0.5rem above safe-area so the logo doesn't crowd the
          // Dynamic Island / camera cutout on iPhone Pro models.
          paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)",
          height: "calc(3rem + env(safe-area-inset-top) + 0.5rem)",
        }}
      >
        <div className="flex items-center gap-2 select-none">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark-transparent.png" alt="" className="h-6 w-auto" />
          <span className="text-zinc-100 font-semibold tracking-tight">Jarela</span>
        </div>
        <button
          onClick={() => { setShowGear((v) => !v); }}
          className={`ml-auto relative p-2 rounded transition-colors ${showGear ? "text-zinc-100 bg-surface-3" : "text-zinc-500 hover:text-zinc-300 hover:bg-surface-3/50"}`}
          title={unreadCount > 0 ? `${unreadCount} new ${unreadCount === 1 ? "alert" : "alerts"}` : "Menu"}
        >
          <Menu size={18} />
          {unreadCount > 0 && (
            <span className="absolute top-1 right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-rose-500 border border-surface-2 text-[9px] font-bold text-white flex items-center justify-center leading-none animate-pulse">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>
      </header>

      <div className="flex-1 relative overflow-hidden">
        {/*
          Each tab is wrapped in <Activity> on its first visit, then kept
          mounted so scroll position, expanded rows, and local form/filter
          state survive tab switches. Background panels stay in the DOM but
          their effects pause until shown again, so data refreshes on focus
          rather than going stale. ChatView keeps its `key={activeAgentId}`
          so picking a different agent still forces a clean remount with
          that agent's thread.

          We lazy-mount on first visit (not eagerly on app start) because
          rendering all 8 panel trees up front blocks Safari/iOS PWA long
          enough to stall the very first paint.
        */}
        {mountedTabs.has("chat") && (
          <Activity mode={state.activeTab === "chat" ? "visible" : "hidden"}>
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
          </Activity>
        )}
        {mountedTabs.has("agents") && (
          <Activity mode={state.activeTab === "agents" ? "visible" : "hidden"}>
            <AgentsPanel />
          </Activity>
        )}
        {mountedTabs.has("memory") && (
          <Activity mode={state.activeTab === "memory" ? "visible" : "hidden"}>
            <MemoryPanel />
          </Activity>
        )}
        {mountedTabs.has("models") && (
          <Activity mode={state.activeTab === "models" ? "visible" : "hidden"}>
            <ModelsPanel />
          </Activity>
        )}
        {mountedTabs.has("mcp") && (
          <Activity mode={state.activeTab === "mcp" ? "visible" : "hidden"}>
            <MCPPanel />
          </Activity>
        )}
        {mountedTabs.has("integrations") && (
          <Activity mode={state.activeTab === "integrations" ? "visible" : "hidden"}>
            <IntegrationsPanel />
          </Activity>
        )}
        {mountedTabs.has("tasks") && (
          <Activity mode={state.activeTab === "tasks" ? "visible" : "hidden"}>
            <ScheduledTasksPanel />
          </Activity>
        )}
        {mountedTabs.has("bridges") && (
          <Activity mode={state.activeTab === "bridges" ? "visible" : "hidden"}>
            <BridgesPanel />
          </Activity>
        )}
        {mountedTabs.has("profile") && (
          <Activity mode={state.activeTab === "profile" ? "visible" : "hidden"}>
            <ProfilePanel />
          </Activity>
        )}

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
