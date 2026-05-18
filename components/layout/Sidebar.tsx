"use client";
import { Brain, Cpu, MessageSquare, Plus, Trash2 } from "lucide-react";
import { useAppContext, type Tab } from "@/contexts/AppContext";
import type { ThreadSummary } from "@/api/types";

interface Props {
  threads: ThreadSummary[];
  onNewThread: () => void;
  onDeleteThread: (id: string) => void;
}

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "chat",   label: "Chat",   icon: <MessageSquare size={13} /> },
  { id: "memory", label: "Memory", icon: <Brain size={13} /> },
  { id: "models", label: "Models", icon: <Cpu size={13} /> },
];

export function Sidebar({ threads, onNewThread, onDeleteThread }: Props) {
  const { state, dispatch } = useAppContext();

  return (
    <aside className="w-64 shrink-0 flex flex-col h-full border-r border-border bg-surface-2">
      {/* Header */}
      <div className="flex items-center px-4 py-3 border-b border-border">
        <span className="font-semibold text-fg text-sm">Jarela</span>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => dispatch({ type: "SET_TAB", tab: tab.id })}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors ${
              state.activeTab === tab.id ? "text-fg border-b-2 border-accent" : "text-fg-subtle hover:text-fg"
            }`}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {state.activeTab === "chat" && (
        <>
          {/* New session button */}
          <div className="px-3 pt-3 pb-1">
            <button
              onClick={onNewThread}
              className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-surface text-fg-muted text-xs font-medium hover:bg-surface-3 hover:text-fg transition-colors"
            >
              <Plus size={13} />
              New session
            </button>
          </div>

          {/* Thread list */}
          <div className="flex-1 overflow-y-auto py-1">
            {threads.length === 0 && (
              <p className="text-fg-faint text-xs text-center py-6 select-none">No conversations yet</p>
            )}
            {threads.map((t) => (
              <div
                key={t.thread_id}
                onClick={() => dispatch({ type: "SELECT_THREAD", threadId: t.thread_id, agentId: t.agent_id })}
                className={`group flex items-center gap-2 px-3 py-2 cursor-pointer rounded-lg mx-1 my-0.5 transition-colors ${
                  state.activeThreadId === t.thread_id ? "bg-surface-3 text-fg" : "text-fg-subtle hover:bg-surface-3 hover:text-fg"
                }`}
              >
                <MessageSquare size={13} className="shrink-0 opacity-60" />
                <span className="flex-1 text-xs truncate">{t.title ?? "New conversation"}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onDeleteThread(t.thread_id); }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 text-fg-faint hover:text-red-400 transition-colors"
                  title="Delete"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
