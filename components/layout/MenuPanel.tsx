"use client";
import { Bot, Brain, Calendar, ChevronDown, Cpu, FolderSearch, Key, MessageSquare, Monitor, Moon, Smartphone, Sun, User, Wrench } from "lucide-react";
import { NotificationTestButton } from "@/components/ui/NotificationStatus";
import { useEffect, useState } from "react";
import type { Tab } from "@/contexts/AppContext";
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
};

const TAB_TITLES: Record<Tab, string> = {
  chat: "Chat",
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
};

// Two-tier menu. "Common" surfaces the day-to-day verbs (chat, agents,
// memory, tasks, bridges, profile). "Advanced" hides the engine room
// (connections, models, tools) behind a collapsible header so first-run
// users aren't faced with eight cards of config they don't yet need.
//
// "connections" is the single home for every auth surface (built-in
// integrations + MCP server credentials). "tools" is purely about
// capability presence — what categories of tools the agent may use.
// The legacy top-level "mcp" and "extensions" tabs remain wired for
// deep-link back-compat but are hidden here.
const COMMON_TABS: Tab[] = ["chat", "agents", "memory", "documents", "tasks", "bridges", "profile"];
const ADVANCED_TABS: Tab[] = ["connections", "models", "tools"];

const ADVANCED_KEY = "jarela.menu.advanced";

const GRADIENTS = [
  "from-violet-500 to-indigo-600",
  "from-blue-500 to-cyan-600",
  "from-emerald-500 to-teal-600",
  "from-orange-500 to-amber-600",
  "from-rose-500 to-pink-600",
  "from-fuchsia-500 to-purple-600",
];

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
      className={`min-w-0 flex flex-col items-center justify-center gap-1 rounded-lg py-2 px-1 transition-colors ${
        activeTab === tab
          ? "bg-surface-3 text-fg ring-1 ring-border"
          : "text-fg-faint hover:text-fg-muted hover:bg-surface-3/50"
      }`}
    >
      <span className="shrink-0">{TAB_ICONS[tab]}</span>
      <span className="text-[10px] leading-none truncate max-w-full">{TAB_TITLES[tab]}</span>
    </button>
  );

  return (
    <div
      className="glass-elevated fixed right-0 bottom-0 w-full sm:w-[26rem] max-w-full border-l border-border/60 z-40 flex flex-col pb-safe"
      style={{ top: "calc(3rem + var(--app-safe-top))" }}
    >
      {/* Common navigation — the day-to-day surface. */}
      <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5 px-2 py-2 border-b border-border shrink-0">
        {COMMON_TABS.map(renderTabButton)}
      </div>

      {/* Advanced (collapsible) — configuration / engine room. */}
      <div className="border-b border-border shrink-0">
        <button
          type="button"
          onClick={toggleAdvanced}
          aria-expanded={advancedOpen}
          className="w-full flex items-center justify-between px-3 py-2 text-[11px] uppercase tracking-wide text-fg-faint hover:text-fg-muted transition-colors"
        >
          <span className="font-medium">Advanced</span>
          <ChevronDown
            size={12}
            className={`transition-transform ${advancedOpen ? "rotate-0" : "-rotate-90"}`}
          />
        </button>
        {advancedOpen && (
          <div className="grid grid-cols-3 gap-1.5 px-2 pb-2">
            {ADVANCED_TABS.map(renderTabButton)}
          </div>
        )}
      </div>

      {/* Main content area */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <AgentSessionList
          activeAgentId={agentId}
          onSelect={(id) => { onAgentChange(id); onSetTab("chat"); onClose(); }}
        />
      </div>

      {/* Display toggles */}
      <div className="border-t border-border px-3 py-3 shrink-0">
        <p className="text-[11px] text-fg-faint mb-1.5 font-medium uppercase tracking-wide">Display</p>
        <div className="flex flex-col gap-1.5">
          <ThemePicker />
          <label className="inline-flex items-center gap-2 cursor-pointer text-xs text-fg-muted">
            <input type="checkbox" className="rounded border-border" checked={showTools} onChange={(e) => onShowToolsChange(e.target.checked)} />
            Show tool events
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer text-xs text-fg-muted">
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
    <div className="flex items-center gap-2 text-xs text-fg-muted">
      <span className="shrink-0">Theme</span>
      <div className="flex flex-1 rounded-md border border-border overflow-hidden">
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => setTheme(o.value)}
            title={o.label}
            className={`flex-1 inline-flex items-center justify-center gap-1 py-1 text-[11px] transition-colors ${
              theme === o.value
                ? "bg-surface-3 text-fg"
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
