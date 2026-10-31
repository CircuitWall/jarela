"use client";
import { useEffect, useRef, useState } from "react";
import { Bot, Copy, Plus, Trash2 } from "lucide-react";
import type { AgentConfig, AgentConfigIn } from "@/api/types";
import { api } from "@/api/client";
import { useAgents } from "@/hooks/useAgents";
import { useModels } from "@/hooks/useModels";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { HeaderAction, PanelHeader } from "@/components/ui/PanelHeader";
import { AgentEditor } from "./AgentEditor";
import { AdvertisementSection } from "./agent-editor/AdvertisementSection";
import { useAppContext } from "@/contexts/AppContext";

import { confirmAction } from "@/lib/ui/confirm";
import { errorMessage } from "@/lib/utils/error";

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
  const { agents, loading, error, create, update, remove, duplicate } = useAgents();
  const { models } = useModels();
  const { state } = useAppContext();
  const [editing, setEditing] = useState<AgentConfig | null | "new">(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastDeepLinkedAgent = useRef<string | null>(null);
  useDeepLinkScroll("agents", "agent", containerRef);

  useEffect(() => {
    const selectedId = state.selectedItem.agents;
    if (!selectedId) {
      lastDeepLinkedAgent.current = null;
      return;
    }
    if (lastDeepLinkedAgent.current === selectedId) return;
    const selectedAgent = agents.find((agent) => agent.id === selectedId);
    if (!selectedAgent) return;
    lastDeepLinkedAgent.current = selectedId;
    setEditing(selectedAgent);
  }, [agents, state.selectedItem.agents]);

  useEffect(() => {
    void Promise.allSettled([
      api.tools.list({ includeDisabled: true }),
      api.credentials.list({ type: "integration" }),
      api.integrations.list(),
      api.harnesses.list(),
    ]);
  }, []);

  async function handleSave(data: AgentConfigIn) {
    if (editing === "new") {
      await create(data);
    } else if (editing) {
      await update(editing.id, data);
    }
  }

  async function handleDuplicate(agent: AgentConfig) {
    setActionError(null);
    setDuplicating(agent.id);
    try {
      setEditing(await duplicate(agent.id));
    } catch (err) {
      setActionError(`Could not duplicate agent: ${errorMessage(err)}`);
    } finally {
      setDuplicating(null);
    }
  }

  async function handleDelete(agent: AgentConfig) {
    setActionError(null);
    try {
      if (!(await confirmAction({ message: `Delete agent "${agent.name}"? This cannot be undone.`, destructive: true }))) return;
      setDeleting(agent.id);
      await remove(agent.id);
    } catch (err) {
      setActionError(`Could not delete agent: ${errorMessage(err)}`);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <>
      <PanelHeader icon={<Bot size={14} />} title="Agents">
        <HeaderAction onClick={() => setEditing("new")} icon={<Plus size={14} />} label="New" />
      </PanelHeader>

      {/* List */}
      <div ref={containerRef} className="flex-1 overflow-y-auto px-[calc(var(--workspace-gutter)/2)] pb-2">
        <AdvertisementSection global models={models} />
        {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400 py-2">{error}</p>}
        {actionError && <p role="alert" className="text-xs text-red-700 dark:text-red-400 py-2">{actionError}</p>}
        {loading && (
          <p className="text-fg-faint text-xs text-center py-4">Loading…</p>
        )}
        {!loading && !error && agents.length === 0 && (
          <p className="text-fg-faint text-xs text-center py-4 select-none">
            No agents yet. Create one to start chatting.
          </p>
        )}
        {agents.map((a) => (
          <AgentRow
            key={a.id}
            agent={a}
            deleting={deleting === a.id}
            duplicating={duplicating === a.id}
            onEdit={() => setEditing(a)}
            onDuplicate={() => { void handleDuplicate(a); }}
            onDelete={() => { void handleDelete(a); }}
          />
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
      </>
    </div>
  );
}

function AgentRow({ agent, deleting, duplicating, onEdit, onDuplicate, onDelete }: {
  agent: AgentConfig;
  deleting: boolean;
  duplicating: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      data-deep-link-id={agent.id}
      className="group flex items-center gap-2.5 px-[calc(var(--workspace-gutter)/2)] py-2 rounded-lg hover:bg-surface-3 transition-colors"
    >
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${agent.name}`}
        className="flex items-center gap-2.5 flex-1 min-w-0 text-left rounded focus-visible:outline-2 focus-visible:outline-accent"
      >
        <AgentAvatar icon={agent.icon} name={agent.name} id={agent.id} />
        <span className="flex-1 min-w-0">
          <span className="block text-xs text-fg font-medium truncate">{agent.name}</span>
          {agent.identity && <span className="block text-[11px] text-fg-faint truncate">{agent.identity}</span>}
        </span>
      </button>
      <div className="flex items-center gap-0.5 opacity-40 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity shrink-0">
        <button
          type="button"
          onClick={onDuplicate}
          disabled={duplicating}
          className="p-1 text-fg-muted hover:text-fg transition-colors disabled:opacity-50"
          title="Duplicate"
          aria-label={`Duplicate ${agent.name}`}
        >
          <Copy size={12} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          className="p-1 text-fg-muted hover:text-red-700 dark:hover:text-red-400 transition-colors disabled:opacity-50"
          title="Delete"
          aria-label={`Delete ${agent.name}`}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}
