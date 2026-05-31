"use client";
import { BarChart3, Bot, Brain, Calendar, ChevronDown, Cpu, FolderSearch, Key, MessageSquare, Monitor, Moon, Shapes, Smartphone, Sun, User, Wrench } from "lucide-react";
import { NotificationTestButton } from "@/components/ui/NotificationStatus";
import { useEffect, useState } from "react";
import { useAppContext, type Tab } from "@/contexts/AppContext";
import type { AgentConfig } from "@/api/types";
import { api } from "@/api/client";
import { useUnreadByAgent } from "@/lib/ui/toasts";
import { useTheme, type Theme } from "@/contexts/ThemeContext";

interface Props {
  activeTab: Tab;
  agentId: string | null;
  showTools: boolean;
  showThinking: boolean;
  onClose: () => void;
  onAgentChange: (agentId: string) => void;
  onSetTab: (tab: Tab) => void;
  onShowToolsChange: (v: boolean) => void;
  onShowThinkingChange: (v: boolean) => void;
}

const TAB_ICONS: Record<Tab, React.ReactNode> = {
  chat: <MessageSquare size={13} />,
  dashboard: <BarChart3 size={13} />,
  agents: <Bot size={13} />,
  memory: <Brain size={13} />,
  documents: <FolderSearch size={13} />,
  models: <Cpu size={13} />,
  mcp: <Wrench size={13} />,
  extensions: <Wrench size={13} />,
  tools: <Wrench size={13} />,
  connections: <Key size={13} />,
  tasks: <Calendar size={13} />,
  bridges: <Smartphone size={13} />,
  profile: <User size={13} />,
  harness: <Shapes size={13} />,
};

const TAB_TITLES: Record<Tab, string> = {
  chat: "Chat",
  dashboard: "Dashboard",
  agents: "Agents",
  memory: "Memory",
  documents: "Documents",
  models: "Models",
  mcp: "MCP",
  extensions: "Extensions",
  tools: "Tools",
  connections: "Connections",
  tasks: "Tasks",
  bridges: "Bridges",
  profile: "Profile",
  harness: "Harness",
};

const TAB_SHORT: Record<Tab, string> = {
  chat: "Chat",
  dashboard: "Dash",
  agents: "AI",
  memory: "Mem",
  documents: "Docs",
  models: "Model",
  mcp: "MCP",
  extensions: "Ext",
  tools: "Tools",
  connections: "Conn",
  tasks: "Tasks",
  bridges: "Bridge",
  profile: "Me",
  harness: "Test",
};

// Two-tier menu. "Common" surfaces the day-to-day verbs plus the most
// relevant configuration touchpoints (models, tools). "Advanced" hides the
// less-frequently used engine-room surfaces behind a collapsible header.
//
// "connections" is the single home for every auth surface (built-in
// integrations + MCP server credentials) and lives in Common so normal-mode
// users can wire Gmail, Google, GitHub etc. without flipping modes. "tools"
// is purely about capability presence — what categories of tools the agent
// may use. "bridges" (mobile companion pairing) sits in Advanced since most
// users won't pair a phone on first setup. The legacy top-level "mcp" and
// "extensions" tabs remain wired for deep-link back-compat but are hidden
// here.
const COMMON_TABS: Tab[] = ["chat", "dashboard", "agents", "documents", "models", "tools", "connections", "tasks", "profile"];
const ADVANCED_TABS: Tab[] = ["memory", "bridges", "harness"];

const ADVANCED_KEY = "jarela.menu.advanced";

const GRADIENTS = [
  "from-violet-500 to-indigo-600",
  "from-blue-500 to-cyan-600",
  "from-emerald-500 to-teal-600",
  "from-orange-500 to-amber-600",
  "from-rose-500 to-pink-600",
  "from-fuchsia-500 to-purple-600",
];

const TAB_ACCENT: Partial<Record<Tab, string>> = {
  chat: "from-sky-500/20 to-cyan-500/5",
  dashboard: "from-cyan-500/20 to-blue-500/5",
  agents: "from-emerald-500/20 to-teal-500/5",
  memory: "from-indigo-500/20 to-violet-500/5",
  documents: "from-amber-500/20 to-orange-500/5",
  tasks: "from-rose-500/20 to-pink-500/5",
  bridges: "from-blue-500/20 to-indigo-500/5",
  profile: "from-fuchsia-500/20 to-purple-500/5",
  connections: "from-cyan-500/20 to-sky-500/5",
  models: "from-violet-500/20 to-indigo-500/5",
  tools: "from-emerald-500/20 to-lime-500/5",
  harness: "from-orange-500/20 to-amber-500/5",
};

function avatarGradient(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(h) % GRADIENTS.length];
}

function AgentSessionList({
  activeAgentId,
  onSelect,
}: {
  activeAgentId: string | null;
  onSelect: (id: string) => void;
}) {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const unread = useUnreadByAgent();

  useEffect(() => {
    let cancelled = false;
    const load = () => api.agents.list().then((rows) => { if (!cancelled) setAgents(rows); }).catch(console.error);
    void load();
    function onAgentsChanged() { void load(); }
    window.addEventListener("jarela:agents-changed", onAgentsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("jarela:agents-changed", onAgentsChanged);
    };
  }, []);

  if (agents.length === 0) {
    return (
      <p className="text-fg-faint text-xs text-center py-6 select-none px-3">
        No agents yet — create one in the Agents tab.
      </p>
    );
  }

  return (
    <div className="py-1.5 space-y-0.5 px-2">
      {agents.map((a) => {
        const isActive = a.id === activeAgentId;
        const n = unread.get(a.id) ?? 0;
        return (
          <button
            key={a.id}
            onClick={() => onSelect(a.id)}
            className={`w-full flex items-center gap-3 px-2.5 py-2.5 rounded-xl transition-colors text-left ${
              isActive
                ? "bg-accent/15 border border-accent/30"
                : "hover:bg-surface-3 border border-transparent"
            }`}
          >
            {/* Avatar */}
            <div className="relative shrink-0">
              {a.icon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={a.icon}
                  alt={a.name}
                  className="w-9 h-9 rounded-lg object-cover"
                />
              ) : (
                <div
                  className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold text-white bg-gradient-to-br select-none ${avatarGradient(a.id)}`}
                >
                  {a.name.charAt(0).toUpperCase()}
                </div>
              )}
              {n > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-rose-500 border border-surface-2 text-[10px] font-bold text-white flex items-center justify-center leading-none">
                  {n > 9 ? "9+" : n}
                </span>
              )}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className={`text-sm font-medium truncate ${isActive ? "text-fg" : "text-fg"}`}>
                  {a.name}
                </span>
                {a.is_default && (
                  <span className="text-[9px] uppercase tracking-wide text-accent font-semibold shrink-0">
                    default
                  </span>
                )}
              </div>
              {a.identity ? (
                <p className="text-[11px] text-fg-faint truncate leading-tight mt-0.5">{a.identity}</p>
              ) : (
                <p className="text-[11px] text-fg-faint italic leading-tight mt-0.5">No persona</p>
              )}
            </div>

            {/* Active indicator */}
            {isActive && (
              <div className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
            )}
          </button>
        );
      })}
    </div>
  );
}

export function MenuPanel({
  activeTab,
  agentId,
  showTools,
  showThinking,
  onClose,
  onAgentChange,
  onSetTab,
  onShowToolsChange,
  onShowThinkingChange,
}: Props) {
  const { state, dispatch } = useAppContext();
  const isAdvanced = state.experienceMode === "advanced";
  const toggleMode = () => {
    dispatch({ type: "SET_EXPERIENCE_MODE", mode: isAdvanced ? "normal" : "advanced" });
  };
  // Advanced section starts collapsed once the user has dismissed it
  // once (persisted to localStorage). Defaults to *expanded* on first
  // boot so the engine room is visible to power users out of the box.
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(true);
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(ADVANCED_KEY);
      if (v != null) setAdvancedOpen(v === "1");
    } catch {
      /* localStorage may throw in private mode; harmless. */
    }
  }, []);
  // If the user navigates into an Advanced tab via deep-link, auto-open
  // the section so the active state is visible.
  useEffect(() => {
    if (ADVANCED_TABS.includes(activeTab) && !advancedOpen) {
      setAdvancedOpen(true);
      try { window.localStorage.setItem(ADVANCED_KEY, "1"); } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const toggleAdvanced = () => {
    setAdvancedOpen((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(ADVANCED_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  const renderTabButton = (tab: Tab) => (
    <button
      key={tab}
      onClick={() => onSetTab(tab)}
      title={TAB_TITLES[tab]}
      aria-label={TAB_TITLES[tab]}
      aria-current={activeTab === tab ? "page" : undefined}
      className={`control-tap min-w-0 relative overflow-hidden flex flex-col items-center justify-center gap-1 rounded-xl py-2 px-1 transition-all duration-200 ${
        activeTab === tab
          ? "bg-surface-3 text-fg ring-1 ring-border shadow-sm"
          : "text-fg-faint hover:text-fg-muted hover:bg-surface-3/50 hover:-translate-y-px"
      }`}
    >
      {activeTab === tab && (
        <span className={`absolute inset-0 bg-gradient-to-br ${TAB_ACCENT[tab] ?? "from-accent/20 to-transparent"}`} />
      )}
      <span className="shrink-0">{TAB_ICONS[tab]}</span>
      <span className="text-[10px] leading-none truncate max-w-full relative z-10 max-[380px]:hidden">{TAB_TITLES[tab]}</span>
      <span className="text-[10px] leading-none truncate max-w-full relative z-10 min-[381px]:hidden">{TAB_SHORT[tab]}</span>
    </button>
  );

  return (
    <div
      className="glass-elevated fixed right-0 bottom-0 w-full sm:w-[26rem] max-w-full border-l border-border/60 z-40 flex flex-col pb-safe"
      style={{ top: "calc(3rem + var(--app-safe-top))" }}
    >
      {/* Common navigation — the day-to-day surface. */}
      <div className="px-3 pt-2 pb-1 border-b border-border/60 bg-gradient-to-r from-surface-2/50 to-transparent">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wide text-fg-faint">Workspace mode</span>
          <button
            type="button"
            onClick={toggleMode}
            title={`Switch to ${isAdvanced ? "normal" : "advanced"} mode`}
            aria-label={`Switch to ${isAdvanced ? "normal" : "advanced"} mode`}
            className={`control-tap text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border transition-colors ${
              isAdvanced
                ? "border-accent/40 bg-accent/10 text-fg-subtle hover:bg-accent/20"
                : "border-border bg-surface-3 text-fg-faint hover:text-fg-muted hover:border-border-strong"
            }`}
          >
            {isAdvanced ? "advanced" : "normal"}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5 px-2 py-2 border-b border-border shrink-0">
        {COMMON_TABS.map(renderTabButton)}
      </div>

      {isAdvanced && (
        <div className="border-b border-border shrink-0">
          <button
            type="button"
            onClick={toggleAdvanced}
            aria-expanded={advancedOpen}
            className="control-tap w-full flex items-center justify-between px-3 py-2 text-[11px] uppercase tracking-wide text-fg-faint hover:text-fg-muted transition-colors bg-gradient-to-r from-surface-2/40 to-transparent"
          >
            <span className="font-medium">Advanced</span>
            <ChevronDown
              size={12}
              className={`transition-transform ${advancedOpen ? "rotate-0" : "-rotate-90"}`}
            />
          </button>
          {advancedOpen && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 px-2 pb-2">
              {ADVANCED_TABS.map(renderTabButton)}
            </div>
          )}
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 overflow-y-auto min-h-0 panel-scrollbar">
        <AgentSessionList
          activeAgentId={agentId}
          onSelect={(id) => { onAgentChange(id); onSetTab("chat"); onClose(); }}
        />
      </div>

      {/* Display toggles */}
      <div className="border-t border-border px-3 py-3 shrink-0 bg-surface-1/30">
        <p className="text-[11px] text-fg-faint mb-1.5 font-medium uppercase tracking-wide">Display</p>
        <div className="flex flex-col gap-1.5">
          <ThemePicker />
          <label className="control-tap inline-flex items-center gap-2 cursor-pointer text-xs text-fg-muted rounded-lg border border-border bg-surface-3/70 px-2.5 py-2">
            <input type="checkbox" className="rounded border-border" checked={showTools} onChange={(e) => onShowToolsChange(e.target.checked)} />
            Show tool events
          </label>
          <label className="control-tap inline-flex items-center gap-2 cursor-pointer text-xs text-fg-muted rounded-lg border border-border bg-surface-3/70 px-2.5 py-2">
            <input type="checkbox" className="rounded border-border" checked={showThinking} onChange={(e) => onShowThinkingChange(e.target.checked)} />
            Show thinking
          </label>
          <div className="pt-1.5">
            <NotificationTestButton />
          </div>
        </div>
      </div>
    </div>
  );
}

function ThemePicker() {
  const { theme, setTheme } = useTheme();
  const options: { value: Theme; label: string; icon: React.ReactNode }[] = [
    { value: "light",  label: "Light",  icon: <Sun size={12} /> },
    { value: "dark",   label: "Dark",   icon: <Moon size={12} /> },
    { value: "system", label: "System", icon: <Monitor size={12} /> },
  ];
  return (
    <div className="flex items-center gap-2 text-xs text-fg-muted rounded-lg border border-border bg-surface-3/70 px-2.5 py-2">
      <span className="shrink-0">Theme</span>
      <div className="flex flex-1 rounded-lg border border-border overflow-hidden bg-surface">
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => setTheme(o.value)}
            title={o.label}
            className={`control-tap flex-1 inline-flex items-center justify-center gap-1 py-1 text-[11px] transition-colors ${
              theme === o.value
                ? "bg-surface-3 text-fg shadow-sm"
                : "text-fg-faint hover:text-fg-muted hover:bg-surface-3/50"
            }`}
          >
            {o.icon}
            <span>{o.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
