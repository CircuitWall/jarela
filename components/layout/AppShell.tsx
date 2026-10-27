"use client";
import { Menu } from "lucide-react";
import { Activity, useCallback, useEffect, useRef, useState } from "react";
import { useAppContext } from "@/contexts/AppContext";
import { useAgentSession } from "@/hooks/useAgentSession";
import { useAgents } from "@/hooks/useAgents";
import { useEventNotifications } from "@/hooks/useEventNotifications";
import { useUrlSync } from "@/hooks/useUrlSync";
import { useConfigurationIssues } from "@/hooks/useConfigurationIssues";
import type { AgentConfig } from "@/api/types";
import { ChatView } from "@/components/chat/ChatView";
import { ModelsPanel } from "@/components/models/ModelsPanel";
import { CredentialsPanel } from "@/components/credentials/CredentialsPanel";
import { AgentsPanel } from "@/components/agents/AgentsPanel";
import { ProfilePanel } from "@/components/profile/ProfilePanel";
import { MCPPanel } from "@/components/mcp/MCPPanel";
import { ToolsPanel } from "@/components/tools/ToolsPanel";
import { ScheduledTasksPanel } from "@/components/scheduled-tasks/ScheduledTasksPanel";
import { BridgesPanel } from "@/components/bridges/BridgesPanel";
import { LogsPanel } from "@/components/logs/LogsPanel";
import { EnvVarsPanel } from "@/components/env/EnvVarsPanel";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { UnifiedMemoryPanel } from "@/components/memory/UnifiedMemoryPanel";
import { HeaderActivity } from "@/components/ui/HeaderActivity";
import { NotificationStatus } from "@/components/ui/NotificationStatus";
import { CryptoFallbackBanner } from "@/components/ui/CryptoFallbackBanner";
import { UpdateAvailableBanner } from "@/components/ui/UpdateAvailableBanner";
import { ServerStatus } from "@/components/ui/ServerStatus";
import { Toaster } from "@/components/ui/Toaster";
import { BootScreen } from "@/components/ui/BootScreen";
import { ScreenLock } from "@/components/setup/ScreenLock";
import { UnlockScreen } from "@/components/setup/UnlockScreen";
import { clearUnreadForAgent, useUnreadCount } from "@/lib/ui/toasts";
import { getAppName } from "@/lib/env/app-config";
import { MenuPanel } from "./MenuPanel";
import { DashboardPanel } from "@/components/dashboard/DashboardPanel";
import { AgentSwitcher } from "./AgentSwitcher";

const ADVANCED_TABS = new Set(["dashboard", "tasks", "tools", "memory", "bridges", "logs", "env"]);

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

  // Redirect legacy deep link ?tab=harness → settings (harnesses now live under Settings).
  useEffect(() => {
    if (state.activeTab === "harness") {
      dispatch({ type: "SET_TAB", tab: "settings" });
      dispatch({ type: "SET_SELECTION", tab: "settings", itemId: "harness" });
    }
  }, [dispatch, state.activeTab]);

  const unreadCount = useUnreadCount();

  // Shared agent list for boot picker, menu, and notification titles.
  const { agents, loading: agentsLoading, error: agentsError, refresh: refreshAgents, update: updateAgent } = useAgents();
  const agentsLoaded = !agentsLoading;
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
  const onSelectAgent = useCallback((agentId: string) => {
    setShowMenu(false);
    dispatch({ type: "SET_AGENT", agentId });
    dispatch({ type: "SET_TAB", tab: "chat" });
  }, [dispatch]);

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
    if (state.activeTab === "chat") {
      clearUnreadForAgent(state.activeAgentId ?? null);
    }
  }, [state.activeTab, state.activeAgentId, unreadCount]);

  // Opening the menu is the only place where global/system alerts are
  // visible when they aren't tied to a specific agent. Consume the null
  // bucket here so the header badge doesn't stay sticky.
  useEffect(() => {
    if (!showMenu) return;
    clearUnreadForAgent(null);
  }, [showMenu]);

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

  // Screen-lock overlay (presence check) AND master-key-locked overlay
  // (decrypt). Distinct from the boot-time gate in `app/page.tsx`:
  // those mounts are triggered mid-session — either by an idle timer
  // (screen-lock) or by the master key being re-locked by an external
  // process (decrypt). Both are signalled by the API client when it
  // sees the matching 423 response.
  const [screenLocked, setScreenLocked] = useState(false);
  const [masterKeyLocked, setMasterKeyLocked] = useState(false);
  const [postUnlockPreferredAgentId, setPostUnlockPreferredAgentId] = useState<string | null | undefined>(undefined);
  // Bumped after each unlock so BootScreen remounts with fresh state
  // (its `done` / `pickedId` / `prefetchStartedRef` would otherwise
  // suppress the picker on the second appearance). Both unlock paths
  // bump this — the agent selector is always the post-unlock landing.
  const [bootSeq, setBootSeq] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    function onScreenLocked() {
      if (!cancelled) setScreenLocked(true);
    }
    function onMasterKeyLocked() {
      if (!cancelled) setMasterKeyLocked(true);
    }
    window.addEventListener("jarela:screen-locked", onScreenLocked);
    window.addEventListener("jarela:master-key-locked", onMasterKeyLocked);

    // Soft poll every 30s so the overlay still appears if no user
    // action triggered a request after the idle timer elapsed.
    async function probe() {
      try {
        const res = await fetch("/api/v1/security/state");
        if (!res.ok) return;
        const body = (await res.json()) as {
          screen_locked?: boolean;
          state?: string;
        };
        if (cancelled) return;
        if (body.state === "locked") setMasterKeyLocked(true);
        if (body.screen_locked === true) setScreenLocked(true);
      } catch (err) {
        // Network blip; try again next tick. Logged at debug-level so
        // a sustained outage is at least findable in devtools.
        if (process.env.NODE_ENV !== "production") {
          console.debug("[security/state] probe failed:", err);
        }
      }
    }
    void probe();
    timer = setInterval(probe, 30_000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      window.removeEventListener("jarela:screen-locked", onScreenLocked);
      window.removeEventListener("jarela:master-key-locked", onMasterKeyLocked);
    };
  }, []);

  // After unlocking, the app may have temporarily lost in-memory list state
  // due to 423 responses. Rehydrate a usable active agent automatically so
  // mobile PWA users are not stranded on a "no agent configured" state.
  useEffect(() => {
    if (postUnlockPreferredAgentId === undefined) return;
    if (!agentsLoaded) return;

    const preferred = postUnlockPreferredAgentId
      ? agents.find((a) => a.id === postUnlockPreferredAgentId) ?? null
      : null;
    const fallback = agents.find((a) => a.is_default) ?? agents[0] ?? null;
    const nextAgent = preferred ?? fallback;

    if (nextAgent && state.activeAgentId !== nextAgent.id) {
      dispatch({ type: "SET_AGENT", agentId: nextAgent.id });
    }
    setPostUnlockPreferredAgentId(undefined);
  }, [agents, agentsLoaded, dispatch, postUnlockPreferredAgentId, state.activeAgentId]);

  // Shared post-unlock landing: clear the current chat and force the
  // BootScreen to remount so the user lands on the agent picker. Used
  // by BOTH the screen-unlock and the master-key decrypt paths so the
  // two transitions feel identical from the user's side.
  const landOnAgentPicker = useCallback(() => {
    const preferredAgentId = stateRef.current.activeAgentId;
    dispatch({ type: "NEW_CHAT" });
    setBootSeq((n) => n + 1);
    setPostUnlockPreferredAgentId(preferredAgentId ?? null);
    void refreshAgents();
  }, [dispatch, refreshAgents]);

  return (
    // `dvh` natively tracks the visible viewport on iOS 16.4+ / modern
    // Chromium, including the on-screen keyboard. The `--actual-vh`
    // override (set by the iOS-standalone-PWA shim in layout.tsx) covers
    // the separate WebKit bug where 100dvh under-reports the physical
    // screen by ~safe-area-inset-top, which leaves a white strip above
    // the home indicator. Inline style instead of `h-[...]` because
    // Tailwind arbitrary values choke on commas inside `var(...)`.
    <div
      className="app-shell flex flex-col text-fg overflow-hidden"
      style={{ height: "var(--actual-vh, 100dvh)" }}
    >
      <BootScreen
        key={bootSeq}
        agents={agents}
        agentsLoaded={agentsLoaded}
        activeAgentId={state.activeAgentId}
        preferredThreadId={state.activeThreadId}
        onPickAgent={(id) => {
          dispatch({ type: "SET_AGENT", agentId: id });
          dispatch({ type: "SET_TAB", tab: "chat" });
        }}
        onCreateAgent={() => dispatch({ type: "SET_TAB", tab: "agents" })}
        suppressed={state.activeTab !== "chat"}
      />
      {screenLocked && !masterKeyLocked && (
        <ScreenLock
          onUnlock={() => {
            // Drop the user back on the picker so they consciously
            // re-enter their workspace rather than landing mid-chat.
            landOnAgentPicker();
            setScreenLocked(false);
          }}
        />
      )}
      {masterKeyLocked && (
        // Master key got re-locked mid-session (e.g. external lock
        // command). Mount the decrypt splash — same shared keypad as
        // boot — and on success drop back to the agent picker. The
        // existing components below stay mounted underneath; once
        // unlocked they resume against the now-unlocked DB.
        //
        // If the screen-lock flag is also up (idle overlap), the
        // decrypt route clears it server-side, so we also drop the
        // screen-lock flag here. One PIN entry covers both.
        <UnlockScreen
          onUnlock={() => {
            landOnAgentPicker();
            setMasterKeyLocked(false);
            if (screenLocked) setScreenLocked(false);
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
        className="glass app-header fixed top-0 left-0 right-0 z-40 flex items-center px-4 border-b border-border/60"
        style={{
          // Top safe-area is mobile-scoped via --app-safe-top so desktop
          // windows stay flush to the edge.
          paddingTop: "var(--app-safe-top)",
          paddingLeft: "calc(env(safe-area-inset-left) + 1rem)",
          paddingRight: "calc(env(safe-area-inset-right) + 1rem)",
          height: "calc(3rem + var(--app-safe-top))",
        }}
      >
        <AgentSwitcher
          agents={agents}
          activeAgentId={state.activeAgentId}
          loading={agentsLoading}
          onSelect={onSelectAgent}
        />
        <HeaderActivity />
        <button
          aria-label="Menu"
          aria-expanded={showMenu}
          aria-controls="main-navigation"
          onClick={() => { setShowMenu((v) => !v); }}
          className={`control-tap ml-auto relative shrink-0 p-2.5 rounded transition-colors xl:hidden ${showMenu ? "text-fg bg-surface-3" : "text-fg-faint hover:text-fg-muted hover:bg-surface-3/50"}`}
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
      <aside
        aria-label="Agents"
        className="glass fixed bottom-0 left-0 z-40 hidden w-64 border-r border-border/60 pb-safe 2xl:block"
        style={{ top: "calc(3rem + var(--app-safe-top))" }}
      >
        <AgentSwitcher
          layout="sidebar"
          agents={agents}
          activeAgentId={state.activeAgentId}
          loading={agentsLoading}
          onSelect={onSelectAgent}
        />
      </aside>

      <div
        data-testid="workspace-content"
        className="workspace-content mx-auto min-h-0 flex-1 relative w-full overflow-hidden"
      >
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
            <UnifiedMemoryPanel />
          </Activity>
        )}
        {mountedTabs.has("models") && (
          <Activity mode={state.activeTab === "models" ? "visible" : "hidden"}>
            <div className="workspace-panel h-full">
              <ModelsPanel />
            </div>
          </Activity>
        )}
        {mountedTabs.has("credentials") && (
          <Activity mode={state.activeTab === "credentials" ? "visible" : "hidden"}>
            <div className="workspace-panel h-full">
              <CredentialsPanel />
            </div>
          </Activity>
        )}
        {mountedTabs.has("mcp") && (
          <Activity mode={state.activeTab === "mcp" ? "visible" : "hidden"}>
            <MCPPanel />
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
        {isFullMode && mountedTabs.has("logs") && (
          <Activity mode={state.activeTab === "logs" ? "visible" : "hidden"}>
            <div className="mx-auto h-full w-full max-w-5xl min-w-0">
              <LogsPanel />
            </div>
          </Activity>
        )}
        {isFullMode && mountedTabs.has("env") && (
          <Activity mode={state.activeTab === "env" ? "visible" : "hidden"}>
            <div className="workspace-panel h-full">
              <EnvVarsPanel />
            </div>
          </Activity>
        )}
        {mountedTabs.has("settings") && (
          <Activity mode={state.activeTab === "settings" ? "visible" : "hidden"}>
            <SettingsPanel />
          </Activity>
        )}

        {showMenu && (
          <div
            className="fixed left-0 right-0 bottom-0 bg-black/20 z-30 xl:hidden"
            style={{ top: "calc(3rem + var(--app-safe-top))" }}
            onClick={() => setShowMenu(false)}
          />
        )}

      </div>
      <MenuPanel
        open={showMenu}
        activeTab={state.activeTab}
        activeAgent={agents.find((agent) => agent.id === state.activeAgentId)}
        agentsLoading={agentsLoading}
        agentsError={agentsError}
        onUpdateAgent={updateAgent}
        onClose={() => setShowMenu(false)}
        onSetTab={(tab) => dispatch({ type: "SET_TAB", tab })}
      />
    </div>
  );
}
