"use client";
import { Bot, Brain, Calendar, Cpu, Key, MessageSquare, Plug, Smartphone, User, X } from "lucide-react";
import { NotificationTestButton } from "@/components/ui/NotificationStatus";
import { useEffect, useState } from "react";
import type { Tab } from "@/contexts/AppContext";
import type { AgentConfig } from "@/api/types";
import { api } from "@/api/client";

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
  models: <Cpu size={13} />,
  mcp: <Plug size={13} />,
  integrations: <Key size={13} />,
  tasks: <Calendar size={13} />,
  bridges: <Smartphone size={13} />,
  profile: <User size={13} />,
};

// Compact label shown under each icon. With 8 tabs at 26rem panel width,
// labels need to stay short to fit without truncation.
const TAB_LABELS: Record<Tab, string> = {
  chat: "Chat",
  agents: "Agents",
  memory: "Memory",
  models: "Models",
  mcp: "MCP",
  integrations: "Creds",
  tasks: "Tasks",
  bridges: "Bridges",
  profile: "You",
};

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

  useEffect(() => {
    api.agents.list().then(setAgents).catch(console.error);
  }, []);

  if (agents.length === 0) {
    return (
      <p className="text-zinc-600 text-xs text-center py-6 select-none px-3">
        No agents yet — create one in the Agents tab.
      </p>
    );
  }

  return (
    <div className="py-1.5 space-y-0.5 px-2">
      {agents.map((a) => {
        const isActive = a.id === activeAgentId;
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
            {a.icon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={a.icon}
                alt={a.name}
                className="w-9 h-9 rounded-lg object-cover shrink-0"
              />
            ) : (
              <div
                className={`w-9 h-9 rounded-lg shrink-0 flex items-center justify-center text-sm font-bold text-white bg-gradient-to-br select-none ${avatarGradient(a.id)}`}
              >
                {a.name.charAt(0).toUpperCase()}
              </div>
            )}

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className={`text-sm font-medium truncate ${isActive ? "text-zinc-100" : "text-zinc-200"}`}>
                  {a.name}
                </span>
                {a.is_default && (
                  <span className="text-[9px] uppercase tracking-wide text-accent font-semibold shrink-0">
                    default
                  </span>
                )}
              </div>
              {a.identity ? (
                <p className="text-[11px] text-zinc-500 truncate leading-tight mt-0.5">{a.identity}</p>
              ) : (
                <p className="text-[11px] text-zinc-600 italic leading-tight mt-0.5">No persona</p>
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

export function GearPanel({
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
  return (
    <div className="absolute right-0 top-0 h-full w-full sm:w-[26rem] max-w-full bg-surface-2 border-l border-border z-20 flex flex-col shadow-2xl pb-safe">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <span className="text-zinc-100 font-semibold tracking-tight select-none">Jarela</span>
        <button onClick={onClose} className="p-1 text-zinc-400 hover:text-zinc-100 transition-colors rounded">
          <X size={15} />
        </button>
      </div>

      {/* Navigation tabs — icon + short label; full name shown on hover */}
      <div className="flex gap-0.5 px-2 py-2 border-b border-border shrink-0">
        {(["chat", "agents", "memory", "models", "mcp", "integrations", "tasks", "bridges", "profile"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => onSetTab(tab)}
            title={tab.charAt(0).toUpperCase() + tab.slice(1)}
            className={`flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 py-1.5 px-0.5 text-[10px] rounded-md font-medium transition-colors whitespace-nowrap ${
              activeTab === tab
                ? "bg-surface-3 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-surface-3/50"
            }`}
          >
            <span className="shrink-0">{TAB_ICONS[tab]}</span>
            <span>{TAB_LABELS[tab]}</span>
          </button>
        ))}
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
        <p className="text-[11px] text-zinc-500 mb-1.5 font-medium uppercase tracking-wide">Display</p>
        <div className="flex flex-col gap-1.5">
          <label className="inline-flex items-center gap-2 cursor-pointer text-xs text-zinc-300">
            <input type="checkbox" className="rounded border-border" checked={showTools} onChange={(e) => onShowToolsChange(e.target.checked)} />
            Show tool events
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer text-xs text-zinc-300">
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
