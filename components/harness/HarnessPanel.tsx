"use client";
import { Lock, Pencil, Plus, Star, Trash2, Wrench } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import {
  HARNESS_SECTION_KEYS,
  type Harness,
  type HarnessIn,
  type HarnessPatch,
  isBuiltinHarnessId,
} from "@/api/types";
import { HarnessEditor } from "./HarnessEditor";
import { errorMessage } from "@/lib/utils/error";

export function HarnessPanel() {
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [defaultId, setDefaultId] = useState<string>("builtin:default");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Harness | "new" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.harnesses.list();
      setHarnesses(res.harnesses);
      setDefaultId(res.default_harness_id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSetDefault(id: string) {
    try {
      await api.harnesses.setDefault(id);
      setDefaultId(id);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this harness? Agents pointing at it will fall back to the global default.")) return;
    try {
      await api.harnesses.delete(id);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function handleClone(source: Harness) {
    const data: HarnessIn = {
      name: `${source.name} (copy)`,
      description: source.description,
      sections: Object.fromEntries(
        HARNESS_SECTION_KEYS.map((k) => [k, { ...source.sections[k] }]),
      ),
    };
    try {
      const created = await api.harnesses.create(data);
      await load();
      setEditing(created);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function handleSave(input: HarnessIn | HarnessPatch, id?: string) {
    if (id) {
      await api.harnesses.update(id, input as HarnessPatch);
    } else {
      await api.harnesses.create(input as HarnessIn);
    }
    await load();
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Wrench size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">Harnesses</h2>
        <button
          onClick={() => setEditing("new")}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors"
        >
          <Plus size={14} /> New
        </button>
      </div>

      <div className="px-4 py-2 border-b border-border bg-surface-2/50 text-xs text-fg-muted">
        Harnesses control the behavioral scaffolding (formatting rules, anti-fabrication, citation,
        self-config) wrapped around every agent&apos;s system prompt. Built-in presets are read-only —
        clone one to customize.
      </div>

      <div className="panel-scrollbar flex-1 overflow-y-auto px-4 py-2">
        {loading && harnesses.length === 0 && (
          <p className="text-fg-faint text-sm py-6 text-center">Loading…</p>
        )}
        {error && <p className="text-red-700 dark:text-red-400 text-xs mb-2 px-1">{error}</p>}
        {!loading && harnesses.length === 0 && (
          <p className="text-fg-faint text-sm py-6 text-center">No harnesses yet</p>
        )}
        {harnesses.map((h) => {
          const isBuiltin = isBuiltinHarnessId(h.id);
          const isDefault = h.id === defaultId;
          const enabledCount = HARNESS_SECTION_KEYS.filter(
            (k) => h.sections[k]?.enabled,
          ).length;
          return (
            <div
              key={h.id}
              className="flex items-center gap-3 py-2.5 border-b border-border/60 group"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-fg truncate">{h.name}</span>
                  {isBuiltin && <Lock size={10} className="text-fg-faint shrink-0" />}
                  {isDefault && (
                    <Star
                      size={11}
                      className="text-yellow-700 dark:text-yellow-400 fill-yellow-400 shrink-0"
                    />
                  )}
                  <span className="text-[10px] text-fg-faint shrink-0">
                    {enabledCount}/{HARNESS_SECTION_KEYS.length} sections
                  </span>
                </div>
                {h.description && (
                  <p className="text-xs text-fg-subtle truncate">{h.description}</p>
                )}
              </div>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity shrink-0">
                {!isDefault && (
                  <button
                    onClick={() => handleSetDefault(h.id)}
                    className="p-1 text-fg-subtle hover:text-yellow-700 dark:hover:text-yellow-400 transition-colors"
                    title="Set as global default"
                  >
                    <Star size={13} />
                  </button>
                )}
                {isBuiltin ? (
                  <button
                    onClick={() => handleClone(h)}
                    className="px-2 py-0.5 text-[11px] text-accent hover:text-accent-hover transition-colors"
                    title="Clone to edit"
                  >
                    Clone
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => setEditing(h)}
                      className="p-1 text-fg-subtle hover:text-fg transition-colors"
                      title="Edit"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => handleDelete(h.id)}
                      className="p-1 text-fg-subtle hover:text-red-700 dark:hover:text-red-400 transition-colors"
                      title="Delete"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {editing !== null && (
        <HarnessEditor
          harness={editing === "new" ? undefined : editing}
          builtins={harnesses.filter((h) => isBuiltinHarnessId(h.id))}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
