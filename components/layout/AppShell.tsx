"use client";
import { Check, ChevronDown, Menu } from "lucide-react";
import { Activity, useCallback, useEffect, useRef, useState } from "react";
import { useAppContext } from "@/contexts/AppContext";
import { useAgentSession } from "@/hooks/useAgentSession";
import { useEventNotifications } from "@/hooks/useEventNotifications";
import { useUrlSync } from "@/hooks/useUrlSync";
import { api } from "@/api/client";
import type { AgentConfig } from "@/api/types";
import { ChatView } from "@/components/chat/ChatView";
import { MemoryPanel } from "@/components/memory/MemoryPanel";
import { ModelsPanel } from "@/components/models/ModelsPanel";
import { DocumentsPanel } from "@/components/documents/DocumentsPanel";import { AgentsPanel } from "@/components/agents/AgentsPanel";
import { ProfilePanel } from "@/components/profile/ProfilePanel";
import { MCPPanel } from "@/components/mcp/MCPPanel";
import { ExtensionsPanel } from "@/components/extensions/ExtensionsPanel";
import { ToolsPanel } from "@/components/tools/ToolsPanel";
import { ConnectionsPanel } from "@/components/connections/ConnectionsPanel";
import { ScheduledTasksPanel } from "@/components/scheduled-tasks/ScheduledTasksPanel";
import { BridgesPanel } from "@/components/bridges/BridgesPanel";
import { HarnessPanel } from "@/components/harness/HarnessPanel";
import { TopProgressBar } from "@/components/ui/TopProgressBar";
import { NotificationStatus } from "@/components/ui/NotificationStatus";
import { CryptoFallbackBanner } from "@/components/ui/CryptoFallbackBanner";
import { UpdateAvailableBanner } from "@/components/ui/UpdateAvailableBanner";
import { ServerStatus } from "@/components/ui/ServerStatus";
import { Toaster } from "@/components/ui/Toaster";
import { clearUnreadForAgent, useUnreadCount } from "@/lib/ui/toasts";
import { getAppName } from "@/lib/env/app-config";
import { MenuPanel } from "./MenuPanel";

const ADVANCED_TABS = new Set(["connections", "models", "tools", "harness"]);

export function AppShell() {
  const { state, dispatch } = useAppContext();
  const isAdvanced = state.experienceMode === "advanced";
  useUrlSync();
  const { threadId, loading: sessionLoading, error: sessionError } = useAgentSession(
    state.activeAgentId,
    state.activeThreadId,
  );

  const [showMenu, setShowMenu] = useState(false);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [showTools, setShowTools] = useState(true);
  const [showThinking, setShowThinking] = useState(true);
  const agentPickerRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (!isAdvanced && ADVANCED_TABS.has(state.activeTab)) {
      dispatch({ type: "SET_TAB", tab: "profile" });
    }
  }, [dispatch, isAdvanced, state.activeTab]);

  const unreadCount = useUnreadCount();

  // Cache agent id → name for notification titles. Refreshed on agent CRUD.
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () => api.agents.list().then((rows) => { if (!cancelled) setAgents(rows); }).catch(() => {});
    void load();
    function onAgentsChanged() { void load(); }
    window.addEventListener("jarela:agents-changed", onAgentsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("jarela:agents-changed", onAgentsChanged);
    };
  }, []);
  const agentsRef = useRef<AgentConfig[]>([]);
  agentsRef.current = agents;

  // Track current view so we can suppress notifications for the agent in focus.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Stable callback references — without these, AppShell re-renders (e.g. on
  // menu toggle, unread counter clearing) hand ChatView fresh function
  // identities. ChatView's hooks re-derive cascading useCallbacks (handleDone
  // → useSSE.consume → useSSE.attach), and effects keyed on `attach` re-fire,
  // forcing a message refetch + chat-window scroll. Stable refs break the cascade.
  const onMessageSent = useCallback(() => {}, []);
  const onSelectAgent = useCallback(
    (id: string) => { dispatch({ type: "SET_AGENT", agentId: id }); },
    [dispatch],
  );

  // Click on an OS Web Notification → useEventNotifications fires a custom
  // event; handle it here to switch to the relevant agent's chat. Prefers
  // landing on the exact thread the event happened in (run reply, scheduled
  // task, bridge message) so the user sees the originating message, not just
  // the agent's last-active thread.
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<{ agentId?: string; threadId?: string | null }>).detail;
      if (!detail?.agentId) return;
      if (detail.threadId) {
        dispatch({ type: "SELECT_THREAD", threadId: detail.threadId, agentId: detail.agentId });
      } else {
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
      if (!agentId) return getAppName();
      const a = agentsRef.current.find((x) => x.id === agentId);
      return a?.name ?? getAppName();
    },
    resolveAgentIcon: (agentId) => {
      if (!agentId) return null;
      const a = agentsRef.current.find((x) => x.id === agentId);
      return a?.icon ?? null;
    },
  });

  // Dismiss the logo-anchored agent picker when tapping outside it.
  useEffect(() => {
    if (!showAgentPicker) return;
    function onPointerDown(e: MouseEvent) {
      const root = agentPickerRef.current;
      if (!root) return;
      if (!root.contains(e.target as Node)) setShowAgentPicker(false);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setShowAgentPicker(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [showAgentPicker]);

  const activeAgent = state.activeAgentId
    ? agents.find((a) => a.id === state.activeAgentId) ?? null
    : null;

  return (
    <div className="h-screen h-[100dvh] flex flex-col text-fg overflow-hidden px-safe">
      <TopProgressBar />
      <NotificationStatus />
      <Toaster />
      <ServerStatus />
      {/*
        Spacer reserving the slot the floating header visually occupies.
        Keeps the flex layout intact so panel content doesn't slide under
        the bar — the bar itself is `fixed` (like TopProgressBar) so it
        always sits on top of scrolling content with a glassy backdrop.
      */}
      <div
        className="shrink-0"
        aria-hidden
        style={{ height: "calc(3rem + var(--app-safe-top))" }}
      />
      <CryptoFallbackBanner />
      <UpdateAvailableBanner />
      <header
        className="glass fixed top-0 left-0 right-0 z-40 flex items-center px-4 border-b border-border/60"
        style={{
          // Top safe-area is mobile-scoped via --app-safe-top so desktop
          // windows stay flush to the edge.
          paddingTop: "var(--app-safe-top)",
          paddingLeft: "calc(env(safe-area-inset-left) + 1rem)",
          paddingRight: "calc(env(safe-area-inset-right) + 1rem)",
          height: "calc(3rem + var(--app-safe-top))",
        }}
      >
        <div className="relative flex items-center gap-2 select-none" ref={agentPickerRef}>
          {/* Logo is blue-on-transparent. In dark mode the blue gets lost
              against the dark glass, so we drop the color and lift the
              alpha to white — `brightness-0` flattens to black, `invert`
              flips it to white, alpha channel is preserved by both. */}
          <button
            type="button"
            onClick={() => setShowAgentPicker((v) => !v)}
            className="inline-flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-surface-3/60 transition-colors"
            title="Select active agent"
            aria-haspopup="menu"
            aria-expanded={showAgentPicker}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-mark-transparent.png" alt="" className="h-6 w-auto dark:brightness-0 dark:invert" />
            <span className="text-fg font-semibold tracking-tight">{getAppName()}</span>
            <span className="text-xs text-fg-faint max-w-[11rem] truncate hidden sm:inline">
              {activeAgent?.name ?? "select agent"}
            </span>
            <ChevronDown size={14} className={`text-fg-faint transition-transform ${showAgentPicker ? "rotate-180" : ""}`} />
          </button>
          {showAgentPicker && (
            <div
              role="menu"
              className="absolute top-full left-0 mt-2 w-[min(24rem,calc(100vw-2rem))] max-h-[55vh] overflow-y-auto rounded-xl border border-border bg-surface-2/95 backdrop-blur-md shadow-2xl p-1.5"
            >
              {agents.length === 0 ? (
                <p className="text-xs text-fg-faint px-2 py-2">No agents available yet.</p>
              ) : (
                agents.map((a) => {
                  const selected = a.id === state.activeAgentId;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      onClick={() => {
                        dispatch({ type: "SET_AGENT", agentId: a.id });
                        dispatch({ type: "SET_TAB", tab: "chat" });
                        setShowAgentPicker(false);
                      }}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-sm transition-colors ${
                        selected
                          ? "bg-surface-3 text-fg"
                          : "text-fg-muted hover:bg-surface-3/60 hover:text-fg"
                      }`}
                    >
                      <span className="w-4 h-4 shrink-0 inline-flex items-center justify-center text-accent">
                        {selected ? <Check size={14} /> : null}
                      </span>
                      {a.icon ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={a.icon} alt="" className="w-5 h-5 rounded-md object-cover shrink-0" />
                      ) : (
                        <span className="w-5 h-5 rounded-md bg-surface-3 text-[10px] font-semibold text-fg-subtle inline-flex items-center justify-center shrink-0">
                          {a.name.charAt(0).toUpperCase()}
                        </span>
                      )}
                      <span className="truncate flex-1">{a.name}</span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
        <button
          onClick={() => { setShowMenu((v) => !v); }}
          className={`ml-auto relative p-2.5 rounded transition-colors ${showMenu ? "text-fg bg-surface-3" : "text-fg-faint hover:text-fg-muted hover:bg-surface-3/50"}`}
          title={unreadCount > 0 ? `${unreadCount} new ${unreadCount === 1 ? "alert" : "alerts"}` : "Menu"}
        >
          <Menu size={21} />
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
        {mountedTabs.has("documents") && (
          <Activity mode={state.activeTab === "documents" ? "visible" : "hidden"}>
            <DocumentsPanel />
          </Activity>
        )}
        {isAdvanced && mountedTabs.has("models") && (
          <Activity mode={state.activeTab === "models" ? "visible" : "hidden"}>
            <ModelsPanel />
          </Activity>
        )}
        {mountedTabs.has("mcp") && (
          <Activity mode={state.activeTab === "mcp" ? "visible" : "hidden"}>
            <MCPPanel />
          </Activity>
        )}
        {mountedTabs.has("extensions") && (
          <Activity mode={state.activeTab === "extensions" ? "visible" : "hidden"}>
            <ExtensionsPanel />
          </Activity>
        )}
        {isAdvanced && mountedTabs.has("tools") && (
          <Activity mode={state.activeTab === "tools" ? "visible" : "hidden"}>
            <ToolsPanel />
          </Activity>
        )}
        {isAdvanced && mountedTabs.has("connections") && (
          <Activity mode={state.activeTab === "connections" ? "visible" : "hidden"}>
            <ConnectionsPanel />
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
        {isAdvanced && mountedTabs.has("harness") && (
          <Activity mode={state.activeTab === "harness" ? "visible" : "hidden"}>
            <HarnessPanel />
          </Activity>
        )}

        {showMenu && (
          <div
            className="fixed left-0 right-0 bottom-0 bg-black/30 backdrop-blur-sm z-30"
            style={{ top: "calc(3rem + var(--app-safe-top))" }}
            onClick={() => setShowMenu(false)}
          />
        )}

        {showMenu && (
          <MenuPanel
            activeTab={state.activeTab}
            agentId={state.activeAgentId}
            showTools={showTools}
            showThinking={showThinking}
            onClose={() => setShowMenu(false)}
            onAgentChange={(agentId) => dispatch({ type: "SET_AGENT", agentId })}
            onSetTab={(tab) => {
              dispatch({ type: "SET_TAB", tab });
              setShowMenu(false);
            }}
            onShowToolsChange={setShowTools}
            onShowThinkingChange={setShowThinking}
          />
        )}
      </div>
    </div>
  );
}
