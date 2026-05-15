"use client";
import { Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { TopProgressBar } from "@/components/ui/TopProgressBar";
import { GearPanel } from "./GearPanel";

export function AppShell() {
  const { state, dispatch } = useAppContext();
  const { threadId, loading: sessionLoading, error: sessionError } = useAgentSession(state.activeAgentId);

  const [showGear, setShowGear] = useState(false);
  const [showTools, setShowTools] = useState(true);
  const [showThinking, setShowThinking] = useState(true);

  // Cache agent id → name for notification titles. Refreshed on agent CRUD.
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  useEffect(() => { api.agents.list().then(setAgents).catch(() => {}); }, []);
  const agentsRef = useRef<AgentConfig[]>([]);
  agentsRef.current = agents;

  // Track current view so we can suppress notifications for the agent in focus.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEventNotifications({
    shouldNotify: (ev) => {
      const tabHidden = typeof document !== "undefined" && document.hidden;
      const onChat = stateRef.current.activeTab === "chat";
      const evAgentId = ev.type === "run_completed" ? ev.agent_id : ev.agent_id;
      const sameAgent = onChat && evAgentId !== null && evAgentId === stateRef.current.activeAgentId;
      // Notify when the user is NOT looking at this agent's chat.
      return tabHidden || !sameAgent;
    },
    resolveAgentName: (agentId) => {
      if (!agentId) return "LangGUI";
      const a = agentsRef.current.find((x) => x.id === agentId);
      return a?.name ?? "LangGUI";
    },
  });

  return (
    <div className="h-screen flex flex-col bg-surface text-zinc-100 overflow-hidden">
      <TopProgressBar />
      <header className="h-9 flex items-center px-3 border-b border-border bg-surface-2 shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.svg" alt="LangGUI" className="h-5 select-none" />
        <button
          onClick={() => setShowGear((v) => !v)}
          className={`ml-auto p-1.5 rounded transition-colors ${showGear ? "text-zinc-100 bg-surface-3" : "text-zinc-500 hover:text-zinc-300"}`}
          title="Menu"
        >
          <Settings size={14} />
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
            onMessageSent={() => {}}
            onSelectAgent={(id) => dispatch({ type: "SET_AGENT", agentId: id })}
          />
        )}
        {state.activeTab === "agents" && <AgentsPanel />}
        {state.activeTab === "memory" && <MemoryPanel />}
        {state.activeTab === "models" && <ModelsPanel />}
        {state.activeTab === "mcp" && <MCPPanel />}
        {state.activeTab === "integrations" && <IntegrationsPanel />}
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
