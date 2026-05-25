"use client";
import { Cpu, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { ModelConfig } from "@/api/types";
import { useModels } from "@/hooks/useModels";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { ModelEditor } from "./ModelEditor";
import { CapBadges } from "./CapBadges";

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "bg-orange-900/40 text-orange-700 dark:text-orange-300 border-orange-700",
  openai: "bg-green-900/40 text-green-700 dark:text-green-300 border-green-700",
  "github-copilot": "bg-purple-900/40 text-purple-300 border-purple-700",
};

export function ModelsPanel() {
  const { models, assignments, loading, create, update, remove, refresh } = useModels();
  const [editing, setEditing] = useState<ModelConfig | null | "new">(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useDeepLinkScroll("models", "model", containerRef);

  async function handleSave(name: string, data: Omit<ModelConfig, "name" | "created_at" | "updated_at">) {
    if (editing === "new") await create(name, data);
    else if (editing) await update(name, data);
    refresh();
  }

  async function handleSetDefault(m: ModelConfig) {
    await update(m.name, { provider: m.provider, model_id: m.model_id, params: m.params, is_default: true });
  }

  async function handleRemove(name: string) {
    setDeleteError(null);
    try {
      await remove(name);
    } catch (e) {
      setDeleteError(`Could not delete "${name}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Cpu size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">Model Configs</h2>
        <button onClick={() => setEditing("new")} className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors">
          <Plus size={14} /> New
        </button>
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto">
        {/* Model list */}
        <div className="px-4 py-2">
          {loading && models.length === 0 && <p className="text-fg-faint text-sm py-6 text-center">Loading…</p>}
          {!loading && models.length === 0 && <p className="text-fg-faint text-sm py-6 text-center">No model configs yet</p>}
          {deleteError && (
            <p className="text-red-700 dark:text-red-400 text-xs mb-2 px-1">{deleteError}</p>
          )}
          {models.map((m) => {
            const inUse = assignments.some((a) => a.model_config_name === m.name);
            return (
            <div key={m.name} data-deep-link-id={m.name} className="flex items-center gap-3 py-2.5 border-b border-border/60 group">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-fg">{m.name}</span>
                  {m.is_default && <Star size={11} className="text-yellow-700 dark:text-yellow-400 fill-yellow-400 shrink-0" />}
                  <span className={`text-xs px-1.5 py-0.5 rounded border ${PROVIDER_COLORS[m.provider] ?? "bg-surface-2 text-fg-muted border-border"}`}>
                    {m.provider}
                  </span>
                </div>
                <p className="text-xs text-fg-subtle truncate">{m.model_id}</p>
                <div className="mt-1">
                  <CapBadges provider={m.provider} modelId={m.model_id} />
                </div>
              </div>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity shrink-0">
                {!m.is_default && (
                  <button onClick={() => handleSetDefault(m)} className="p-1 text-fg-subtle hover:text-yellow-700 dark:hover:text-yellow-400 transition-colors" title="Set as default">
                    <Star size={13} />
                  </button>
                )}
                <button onClick={() => setEditing(m)} className="p-1 text-fg-subtle hover:text-fg transition-colors" title="Edit">
                  <Pencil size={13} />
                </button>
                <button
                  onClick={() => handleRemove(m.name)}
                  disabled={inUse}
                  className="p-1 text-fg-subtle hover:text-red-700 dark:hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={inUse ? "Unassign from agents first" : "Delete"}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
            );
          })}
        </div>

      </div>

      {editing !== null && (
        <ModelEditor
          model={editing === "new" ? undefined : editing}
          onSave={handleSave}
          onClose={() => { setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}
