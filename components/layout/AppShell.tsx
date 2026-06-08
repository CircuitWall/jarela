"use client";
import { Check, ChevronDown, Menu } from "lucide-react";
import { Activity, useCallback, useEffect, useRef, useState } from "react";
import { useAppContext } from "@/contexts/AppContext";
import { useAgentSession } from "@/hooks/useAgentSession";
import { useEventNotifications } from "@/hooks/useEventNotifications";
import { useUrlSync } from "@/hooks/useUrlSync";
import { useConfigurationIssues } from "@/hooks/useConfigurationIssues";
import { api } from "@/api/client";
import type { AgentConfig } from "@/api/types";
import { ChatView } from "@/components/chat/ChatView";
import { MemoryPanel } from "@/components/memory/MemoryPanel";
import { ModelsPanel } from "@/components/models/ModelsPanel";
import { CredentialsPanel } from "@/components/credentials/CredentialsPanel";
import { DocumentsPanel } from "@/components/documents/DocumentsPanel";import { AgentsPanel } from "@/components/agents/AgentsPanel";
import { ProfilePanel } from "@/components/profile/ProfilePanel";
import { MCPPanel } from "@/components/mcp/MCPPanel";
import { ExtensionsPanel } from "@/components/extensions/ExtensionsPanel";
import { ToolsPanel } from "@/components/tools/ToolsPanel";
import { ScheduledTasksPanel } from "@/components/scheduled-tasks/ScheduledTasksPanel";
import { BridgesPanel } from "@/components/bridges/BridgesPanel";
import { HarnessPanel } from "@/components/harness/HarnessPanel";
import { LogsPanel } from "@/components/logs/LogsPanel";
import { EnvVarsPanel } from "@/components/env/EnvVarsPanel";
import { HeaderActivity } from "@/components/ui/HeaderActivity";
import { NotificationStatus } from "@/components/ui/NotificationStatus";
import { CryptoFallbackBanner } from "@/components/ui/CryptoFallbackBanner";
import { UpdateAvailableBanner } from "@/components/ui/UpdateAvailableBanner";
import { ServerStatus } from "@/components/ui/ServerStatus";
import { Toaster } from "@/components/ui/Toaster";
import { Logo } from "@/components/ui/Logo";
import { BootScreen } from "@/components/ui/BootScreen";
import { ScreenLock } from "@/components/setup/ScreenLock";
import { clearUnreadForAgent, useUnreadCount } from "@/lib/ui/toasts";
import { getAppName } from "@/lib/env/app-config";
import { MenuPanel } from "./MenuPanel";
import { DashboardPanel } from "@/components/dashboard/DashboardPanel";

const ADVANCED_TABS = new Set(["memory", "bridges", "harness", "logs", "env"]);

export function AppShell() {
  const { state, dispatch } = useAppContext();
  const isFullMode = state.experienceMode === "full";
  useUrlSync();
  useConfigurationIssues();
  const { threadId, loading: sessionLoading, error: sessionError } = useAgentSession(
    state.activeAgentId,
    state.activeThreadId,
  );

  const [showMenu, setShowMenu] = useState(false);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
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
    if (!isFullMode && ADVANCED_TABS.has(state.activeTab)) {
      dispatch({ type: "SET_TAB", tab: "profile" });
    }
  }, [dispatch, isFullMode, state.activeTab]);

  const unreadCount = useUnreadCount();

  // Cache agent id → name for notification titles. Refreshed on agent CRUD.
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.agents
        .list()
        .then((rows) => { if (!cancelled) setAgents(rows); })
        .catch(() => {})
        .finally(() => { if (!cancelled) setAgentsLoaded(true); });
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

  // Screen-lock overlay. Distinct from the boot-time master-key unlock
  // (that's gated server-side in `app/page.tsx`). This one is the
  // presence check that fires after `idle_timeout_ms` of inactivity:
  // background work keeps running but the UI is hidden until the user
  // re-enters their PIN. Triggered either by a 423 `screen-locked`
  // response from the api client or by the periodic state probe below.
  const [screenLocked, setScreenLocked] = useState(false);
  // Bumped after each unlock so BootScreen remounts with fresh state
  // (its `done` / `pickedId` / `prefetchStartedRef` would otherwise
  // suppress the picker on the second appearance).
  const [bootSeq, setBootSeq] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    function onLocked() {
      if (!cancelled) setScreenLocked(true);
    }
    window.addEventListener("jarela:screen-locked", onLocked);

    // Soft poll every 30s so the overlay still appears if no user
    // action triggered a request after the idle timer elapsed.
    async function probe() {
      try {
        const res = await fetch("/api/v1/security/state");
        if (!res.ok) return;
        const body = (await res.json()) as { screen_locked?: boolean };
        if (!cancelled && body.screen_locked === true) {
          setScreenLocked(true);
        }
      } catch {
        // Network blip; try again next tick.
      }
    }
    void probe();
    timer = setInterval(probe, 30_000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      window.removeEventListener("jarela:screen-locked", onLocked);
    };
  }, []);

  return (
    // `dvh` natively tracks the visible viewport on iOS 16.4+ / modern
    // Chromium, including the on-screen keyboard. The `--actual-vh`
    // override (set by the iOS-standalone-PWA shim in layout.tsx) covers
    // the separate WebKit bug where 100dvh under-reports the physical
    // screen by ~safe-area-inset-top, which leaves a white strip above
    // the home indicator. Inline style instead of `h-[...]` because
    // Tailwind arbitrary values choke on commas inside `var(...)`.
    <div
      className="flex flex-col text-fg overflow-hidden px-safe"
      style={{ height: "var(--actual-vh, 100dvh)" }}
    >
      <BootScreen
        key={bootSeq}
        agents={agents}
        agentsLoaded={agentsLoaded}
        activeAgentId={state.activeAgentId}
        onPickAgent={(id) => {
          dispatch({ type: "SET_AGENT", agentId: id });
          dispatch({ type: "SET_TAB", tab: "chat" });
        }}
        suppressed={state.activeTab !== "chat"}
      />
      {screenLocked && (
        <ScreenLock
          onUnlock={() => {
            // Drop the user back on the picker so they consciously
            // re-enter their workspace rather than landing mid-chat.
            dispatch({ type: "NEW_CHAT" });
            setBootSeq((n) => n + 1);
            setScreenLocked(false);
          }}
        />
      )}
      <NotificationStatus />
      <Toaster />
      <ServerStatus />
      {/*
        Spacer reserving the slot the floating header visually occupies.
        Keeps the flex layout intact so panel content doesn't slide under
        the bar — the bar itself is `fixed` (like TopProgressBar) so it
        always sits on top of scrolling content with a glassy backdrop.

        Omitted on the chat tab: the MessageList scroll viewport has a
        top mask-image fade designed to dissolve messages under the glass
        header. Reserving the slot would defeat that — messages would
        butt against an empty band beneath the header instead of scrolling
        behind it.
      */}
      {state.activeTab !== "chat" && (
        <div
          className="shrink-0"
          aria-hidden
          style={{ height: "calc(3rem + var(--app-safe-top))" }}
        />
      )}
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
          <button
            type="button"
            onClick={() => setShowAgentPicker((v) => !v)}
            className="control-tap inline-flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-surface-3/60 transition-colors"
            title={activeAgent ? `Active agent: ${activeAgent.name} — click to switch` : "Select active agent"}
            aria-haspopup="menu"
            aria-expanded={showAgentPicker}
          >
            {activeAgent?.icon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={activeAgent.icon}
                alt=""
                className="h-6 w-6 rounded-md object-cover shrink-0"
              />
            ) : activeAgent ? (
              <span
                aria-hidden
                className="h-6 w-6 rounded-md bg-surface-3 text-[11px] font-semibold text-fg-subtle inline-flex items-center justify-center shrink-0"
              >
                {activeAgent.name.charAt(0).toUpperCase()}
              </span>
            ) : (
              // No active agent yet — fall back to the app mark. The Logo
              // component renders both color variants and CSS picks the
              // visible one based on the active theme.
              <Logo className="h-6 w-auto" />
            )}
            <span className="text-fg font-semibold tracking-tight truncate max-w-[12rem] sm:max-w-[16rem]">
              {activeAgent?.name ?? getAppName()}
            </span>
            <ChevronDown size={14} className={`text-fg-faint transition-transform ${showAgentPicker ? "rotate-180" : ""}`} />
          </button>
          {showAgentPicker && (
            <div
              role="menu"
              className="panel-scrollbar absolute top-full left-0 mt-2 w-[min(24rem,calc(100vw-2rem))] max-h-[55vh] overflow-y-auto rounded-xl border border-border bg-surface-2/95 backdrop-blur-md shadow-2xl p-1.5"
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
                      className={`control-tap w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-sm transition-colors ${
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
        <HeaderActivity />
        <button
          onClick={() => { setShowMenu((v) => !v); }}
          className={`control-tap ml-auto relative p-2.5 rounded transition-colors ${showMenu ? "text-fg bg-surface-3" : "text-fg-faint hover:text-fg-muted hover:bg-surface-3/50"}`}
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
              onMessageSent={onMessageSent}
            />
          </Activity>
        )}
        {mountedTabs.has("dashboard") && (
          <Activity mode={state.activeTab === "dashboard" ? "visible" : "hidden"}>
            <DashboardPanel />
          </Activity>
        )}
        {mountedTabs.has("agents") && (
          <Activity mode={state.activeTab === "agents" ? "visible" : "hidden"}>
            <AgentsPanel />
          </Activity>
        )}
        {isFullMode && mountedTabs.has("memory") && (
          <Activity mode={state.activeTab === "memory" ? "visible" : "hidden"}>
            <MemoryPanel />
          </Activity>
        )}
        {mountedTabs.has("documents") && (
          <Activity mode={state.activeTab === "documents" ? "visible" : "hidden"}>
            <DocumentsPanel />
          </Activity>
        )}
        {mountedTabs.has("models") && (
          <Activity mode={state.activeTab === "models" ? "visible" : "hidden"}>
            <ModelsPanel />
          </Activity>
        )}
        {mountedTabs.has("credentials") && (
          <Activity mode={state.activeTab === "credentials" ? "visible" : "hidden"}>
            <CredentialsPanel />
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
        {mountedTabs.has("tools") && (
          <Activity mode={state.activeTab === "tools" ? "visible" : "hidden"}>
            <ToolsPanel />
          </Activity>
        )}
        {mountedTabs.has("tasks") && (
          <Activity mode={state.activeTab === "tasks" ? "visible" : "hidden"}>
            <ScheduledTasksPanel />
          </Activity>
        )}
        {isFullMode && mountedTabs.has("bridges") && (
          <Activity mode={state.activeTab === "bridges" ? "visible" : "hidden"}>
            <BridgesPanel />
          </Activity>
        )}
        {mountedTabs.has("profile") && (
          <Activity mode={state.activeTab === "profile" ? "visible" : "hidden"}>
            <ProfilePanel />
          </Activity>
        )}
        {isFullMode && mountedTabs.has("harness") && (
          <Activity mode={state.activeTab === "harness" ? "visible" : "hidden"}>
            <HarnessPanel />
          </Activity>
        )}
        {isFullMode && mountedTabs.has("logs") && (
          <Activity mode={state.activeTab === "logs" ? "visible" : "hidden"}>
            <LogsPanel />
          </Activity>
        )}
        {isFullMode && mountedTabs.has("env") && (
          <Activity mode={state.activeTab === "env" ? "visible" : "hidden"}>
            <EnvVarsPanel />
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
            onClose={() => setShowMenu(false)}
            onAgentChange={(agentId) => dispatch({ type: "SET_AGENT", agentId })}
            onSetTab={(tab) => {
              dispatch({ type: "SET_TAB", tab });
              setShowMenu(false);
            }}
          />
        )}
      </div>
    </div>
  );
}
