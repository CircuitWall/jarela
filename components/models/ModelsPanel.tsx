"use client";
import { Cpu, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ModelConfig } from "@/api/types";
import { useModels } from "@/hooks/useModels";
import { ModelEditor } from "./ModelEditor";

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "bg-orange-900/40 text-orange-300 border-orange-700",
  openai: "bg-green-900/40 text-green-300 border-green-700",
  "github-copilot": "bg-purple-900/40 text-purple-300 border-purple-700",
  custom-provider: "bg-blue-900/40 text-blue-300 border-blue-700",
};

export function ModelsPanel() {
  const { models, loading, create, update, remove, refresh } = useModels();
  const [editing, setEditing] = useState<ModelConfig | null | "new">(null);

  async function handleSave(name: string, data: Omit<ModelConfig, "name" | "created_at" | "updated_at">) {
    if (editing === "new") await create(name, data);
    else if (editing) await update(name, data);
    refresh();
  }

  async function handleSetDefault(m: ModelConfig) {
    await update(m.name, { provider: m.provider, model_id: m.model_id, params: m.params, is_default: true });
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Cpu size={14} className="text-zinc-400" />
        <h2 className="text-sm font-semibold text-zinc-100 mr-auto">Model Configs</h2>
        <button onClick={() => setEditing("new")} className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors">
          <Plus size={14} /> New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Model list */}
        <div className="px-4 py-2">
          {loading && models.length === 0 && <p className="text-zinc-500 text-sm py-6 text-center">Loading…</p>}
          {!loading && models.length === 0 && <p className="text-zinc-500 text-sm py-6 text-center">No model configs yet</p>}
          {models.map((m) => (
            <div key={m.name} className="flex items-center gap-3 py-2.5 border-b border-border/60 group">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-zinc-100">{m.name}</span>
                  {m.is_default && <Star size={11} className="text-yellow-400 fill-yellow-400 shrink-0" />}
                  <span className={`text-xs px-1.5 py-0.5 rounded border ${PROVIDER_COLORS[m.provider] ?? "bg-zinc-800 text-zinc-300 border-zinc-600"}`}>
                    {m.provider}
                  </span>
                </div>
                <p className="text-xs text-zinc-400 truncate">{m.model_id}</p>
              </div>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                {!m.is_default && (
                  <button onClick={() => handleSetDefault(m)} className="p-1 text-zinc-400 hover:text-yellow-400 transition-colors" title="Set as default">
                    <Star size={13} />
                  </button>
                )}
                <button onClick={() => setEditing(m)} className="p-1 text-zinc-400 hover:text-zinc-100 transition-colors" title="Edit">
                  <Pencil size={13} />
                </button>
                <button onClick={() => remove(m.name)} className="p-1 text-zinc-400 hover:text-red-400 transition-colors" title="Delete">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
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
