"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Edit3, RotateCcw, Save, ServerCog, Search, X } from "lucide-react";
import { EnvValueInput, ENV_TYPE_LABEL } from "@/components/env/EnvValueInput";
import { ENV_CATEGORIES, type EnvCategory } from "@/lib/env/schema";

import { useRuntimeEnvSettings, type RuntimeEnvRow as EnvRow } from "./useRuntimeEnvSettings";

const CATEGORY_LABEL = new Map(ENV_CATEGORIES.map(({ id, label }) => [id, label]));

/**
 * Edit-runtime-overrides panel. Lists every JARELA_* var the schema knows
 * about, lets the user override any of them (persisted to
 * ~/.jarela/env-overrides.json), and surfaces a Restart button when the
 * pending changes flag a requiresRestart=true row.
 */
export function EnvVarsPanel() {
  const {
    rows,
    loading,
    error,
    setError,
    editing,
    setEditing,
    saving,
    restartNeeded,
    restarting,
    onSave,
    onReset,
    onRestart,
  } = useRuntimeEnvSettings("runtime", "user clicked Restart in EnvVarsPanel");
  const [search, setSearch] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const editInputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);

  useEffect(() => {
    if (editing) editInputRef.current?.focus();
  }, [editing]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (!showAdvanced && row.tier === "C") return false;
      if (!showAdvanced && row.tier === "B") return q.length > 0; // hide B unless searching or advanced on
      if (q && !row.name.toLowerCase().includes(q) && !row.description.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [rows, search, showAdvanced]);

  const grouped = useMemo(() => {
    const m = new Map<EnvCategory, EnvRow[]>();
    for (const { id } of ENV_CATEGORIES) m.set(id, []);
    for (const row of filtered) {
      if (!m.has(row.category)) m.set(row.category, []);
      m.get(row.category)!.push(row);
    }
    return Array.from(m.entries()).filter(([, list]) => list.length > 0);
  }, [filtered]);

  const startEdit = useCallback((row: EnvRow) => {
    setEditing({ name: row.name, value: row.current });
  }, [setEditing]);

  const cancelEdit = useCallback(() => setEditing(null), [setEditing]);

  return (
    <div className="workspace-gutter flex flex-col h-full min-h-0 py-4 gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-medium text-fg">Runtime settings</h2>
        <span className="text-[10px] text-fg-faint">{rows.length} settings</span>
        <div className="flex-1" />
        <label className="inline-flex items-center gap-1 text-[11px] text-fg-faint cursor-pointer">
          <input
            type="checkbox"
            className="rounded border-border"
            checked={showAdvanced}
            onChange={(e) => setShowAdvanced(e.target.checked)}
          />
          Show advanced (B/C tier)
        </label>
        <div className="flex items-center gap-1 text-[11px]">
          <Search size={12} className="text-fg-faint" aria-hidden />
          <input
            type="text"
            placeholder="filter…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-2 py-0.5 rounded border border-border bg-surface text-fg w-32 text-[11px]"
          />
        </div>
      </div>

      <p className="text-[11px] text-fg-faint">
        Supported JARELA settings only. Preflight values such as the data directory must be set before launch; build-time NEXT_PUBLIC branding is configured in the build environment. Postflight overrides can be changed here. Launch-time values take precedence; restart badges show when changes need a relaunch. Credentials, models, networking, and MCP variables have dedicated settings.
      </p>

      {restartNeeded && (
        <div className="px-3 py-2 rounded border border-amber-700/50 bg-amber-900/20 text-amber-700 dark:text-amber-300 text-xs flex items-center gap-2">
          <ServerCog size={14} aria-hidden />
          <span className="flex-1">A change you made requires a server restart to take effect.</span>
          <button
            type="button"
            disabled={restarting}
            onClick={onRestart}
            className="px-2 py-0.5 rounded bg-amber-600/80 text-white hover:bg-amber-600 disabled:opacity-50 text-[11px]"
          >
            {restarting ? "Restarting…" : "Restart server"}
          </button>
        </div>
      )}

      {error && (
        <div className="px-3 py-2 rounded border border-rose-700/60 bg-rose-900/30 text-rose-700 dark:text-rose-300 text-xs flex items-center gap-2">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="px-1" aria-label="dismiss">
            <X size={12} />
          </button>
        </div>
      )}

      <div className="panel-scrollbar flex-1 min-h-0 overflow-y-auto rounded-md border border-border bg-surface">
        {loading ? (
          <div className="p-4 text-fg-faint text-xs">Loading…</div>
        ) : grouped.length === 0 ? (
          <div className="p-4 text-fg-faint text-xs text-center">No vars match the current filter.</div>
        ) : (
          grouped.map(([category, list]) => (
            <div key={category} className="border-b border-border/40 last:border-b-0">
              <div className="sticky top-0 z-10 bg-surface-2/80 backdrop-blur px-3 py-1 text-[10px] uppercase tracking-wider text-fg-faint border-b border-border/40">
                {CATEGORY_LABEL.get(category) ?? category}
              </div>
              <ul className="divide-y divide-border/30">
                {list.map((row) => (
                  <RuntimeSettingRow
                    key={row.name}
                    row={row}
                    editing={editing}
                    setEditing={setEditing}
                    editInputRef={editInputRef}
                    onSave={onSave}
                    cancelEdit={cancelEdit}
                    saving={saving}
                    startEdit={startEdit}
                    onReset={onReset}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function RuntimeSettingRow({ row, editing, setEditing, editInputRef, onSave, cancelEdit, saving, startEdit, onReset }: {
  row: EnvRow;
  editing: { name: string; value: string; } | null;
  setEditing: React.Dispatch<React.SetStateAction<{ name: string; value: string; } | null>>;
  editInputRef: React.RefObject<HTMLInputElement | HTMLSelectElement | null>;
  onSave: () => void;
  cancelEdit: () => void;
  saving: boolean;
  startEdit: (row: EnvRow) => void;
  onReset: (row: EnvRow) => void;
}) {
  return (
    <li key={row.name} className="px-3 py-2 hover:bg-surface-2/40">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <code className="text-[12px] font-mono text-fg">{row.name}</code>
            <span className="px-1.5 rounded text-[9px] uppercase tracking-wider bg-fg-faint/10 text-fg-faint" title={`Value type: ${ENV_TYPE_LABEL[row.type]}`}>
              {ENV_TYPE_LABEL[row.type]}
            </span>
            {row.overridden && (
              <span className="px-1.5 rounded text-[9px] uppercase tracking-wider bg-emerald-500/20 text-emerald-700 dark:text-emerald-300">
                overridden
              </span>
            )}
            {row.requiresRestart && (
              <span className="px-1.5 rounded text-[9px] uppercase tracking-wider bg-amber-500/20 text-amber-700 dark:text-amber-300">
                restart
              </span>
            )}
            {row.phase === "preflight" && (
              <span className="px-1.5 rounded text-[9px] uppercase tracking-wider bg-sky-500/20 text-sky-700 dark:text-sky-300">
                preflight
              </span>
            )}
            {row.agentWritable && (
              <span className="px-1.5 rounded text-[9px] uppercase tracking-wider bg-sky-500/20 text-sky-700 dark:text-sky-300">
                agent-writable
              </span>
            )}
            <span className="px-1.5 rounded text-[9px] uppercase tracking-wider bg-fg-faint/15 text-fg-faint">
              tier {row.tier}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-fg-muted">{row.description}</div>
          {editing?.name === row.name ? (
            <div className="mt-1.5 flex items-center gap-1.5">
              <EnvValueInput
                type={row.type}
                value={editing.value}
                onChange={(value) => setEditing({ name: row.name, value })}
                enumValues={row.enumValues}
                min={row.min}
                max={row.max}
                inputRef={(element) => { editInputRef.current = element; }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onSave();
                  if (event.key === "Escape") cancelEdit();
                }}
                ariaLabel={row.name}
                className="px-2 py-1 rounded border border-border bg-surface text-fg text-[11px] font-mono w-48"
              />
              <button
                type="button"
                onClick={onSave}
                disabled={saving}
                className="px-2 py-1 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50 text-[11px] inline-flex items-center gap-1"
              >
                <Save size={11} /> Save
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                className="px-2 py-1 rounded border border-border text-fg-faint hover:bg-surface-2 text-[11px]"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="mt-0.5 flex items-center gap-2 flex-wrap">
              <code className="text-[11px] font-mono text-fg-muted">
                {row.current}
              </code>
              {row.overridden && (
                <span className="text-[10px] text-fg-faint">
                  (default: <code className="font-mono">{String(row.default)}</code>)
                </span>
              )}
            </div>
          )}
        </div>
        {editing?.name !== row.name && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => startEdit(row)}
              className="p-1.5 rounded border border-border text-fg-faint hover:bg-surface-2 hover:text-fg"
              title="Edit"
            >
              <Edit3 size={12} />
            </button>
            <button
              type="button"
              onClick={() => onReset(row)}
              disabled={!row.overridden}
              className="p-1.5 rounded border border-border text-fg-faint hover:bg-surface-2 hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
              title={row.overridden ? "Reset to default" : "No override to reset"}
            >
              <RotateCcw size={12} />
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
