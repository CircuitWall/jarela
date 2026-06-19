"use client";
import { useRef, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { AgentConfig, AgentConfigIn } from "@/api/types";
import { useAgents } from "@/hooks/useAgents";
import { useModels } from "@/hooks/useModels";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { Button } from "@/components/ui/Button";
import { AgentEditor } from "./AgentEditor";

const AVATAR_GRADIENTS = [
  "from-violet-500 to-indigo-600",
  "from-blue-500 to-cyan-600",
  "from-emerald-500 to-teal-600",
  "from-orange-500 to-amber-600",
  "from-rose-500 to-pink-600",
  "from-fuchsia-500 to-purple-600",
];

function agentGradient(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
}

function AgentAvatar({ icon, name, id }: { icon: string | null; name: string; id: string }) {
  if (icon) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={icon}
        alt={name}
        className="w-8 h-8 rounded-lg object-cover shrink-0"
      />
    );
  }
  return (
    <div
      className={`w-8 h-8 rounded-lg bg-gradient-to-br ${agentGradient(id)} flex items-center justify-center text-white text-sm font-bold shrink-0 select-none shadow-sm`}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

export function AgentsPanel() {
  const { agents, loading, create, update, remove } = useAgents();
  const { models } = useModels();
  const [editing, setEditing] = useState<AgentConfig | null | "new">(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useDeepLinkScroll("agents", "agent", containerRef);

  async function handleSave(data: AgentConfigIn) {
    if (editing === "new") {
      await create(data);
    } else if (editing) {
      await update(editing.id, data);
    }
  }

  async function handleDelete(agent: AgentConfig) {
    if (!confirm(`Delete agent "${agent.name}"? This cannot be undone.`)) return;
    setDeleting(agent.id);
    try {
      await remove(agent.id);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-2 shrink-0">
        <span className="text-[11px] text-fg-faint font-medium uppercase tracking-wide">Agents</span>
        <Button
          onClick={() => setEditing("new")}
          size="sm"
          icon={<Plus size={11} />}
        >
          New
        </Button>
      </div>

      {/* List */}
      <div ref={containerRef} className="flex-1 overflow-y-auto px-2 pb-2">
        {loading && (
          <p className="text-fg-faint text-xs text-center py-4">Loading…</p>
        )}
        {!loading && agents.length === 0 && (
          <p className="text-fg-faint text-xs text-center py-4 select-none">
            No agents yet. Create one to start chatting.
          </p>
        )}
        {agents.map((a) => (
          <div
            key={a.id}
            data-deep-link-id={a.id}
            className="group flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-surface-3 transition-colors"
          >
            <AgentAvatar icon={a.icon} name={a.name} id={a.id} />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-fg font-medium truncate">{a.name}</p>
              {a.identity && (
                <p className="text-[11px] text-fg-faint truncate">{a.identity}</p>
              )}
            </div>
            <div className="flex items-center gap-0.5 opacity-40 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity shrink-0">
              <button
                onClick={() => setEditing(a)}
                className="p-1 text-fg-muted hover:text-fg transition-colors"
                title="Edit"
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={() => void handleDelete(a)}
                disabled={deleting === a.id}
                className="p-1 text-fg-muted hover:text-red-700 dark:hover:text-red-400 transition-colors disabled:opacity-50"
                title="Delete"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Editor modal */}
      {editing !== null && (
        <AgentEditor
          agent={editing === "new" ? undefined : editing}
          models={models}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
