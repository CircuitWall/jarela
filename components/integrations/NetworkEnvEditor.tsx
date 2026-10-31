"use client";

import { Edit3, Network, RotateCcw, Save, ServerCog } from "lucide-react";
import { EnvValueInput, ENV_TYPE_LABEL } from "@/components/env/EnvValueInput";

import { useRuntimeEnvSettings, type RuntimeEnvRow } from "@/components/env/useRuntimeEnvSettings";

// Inline editor for the `category === "network"` slice of /api/v1/env
// (bind host, port, HTTP/SSE timeouts, retry count). Rendered as a
// section inside Settings → Networking so all networking knobs live
// next to one another instead of being scattered across User Profile.
// The same vars no longer appear in EnvVarsPanel.
export function NetworkEnvEditor() {
  const {
    rows,
    loading,
    error,
    editing,
    setEditing,
    saving,
    restartNeeded,
    restarting,
    onSave,
    onReset,
    onRestart,
  } = useRuntimeEnvSettings("network", "user clicked Restart in NetworkPanel");

  return (
    <div className="rounded-xl border border-border bg-surface-2/70 p-4 mt-4">
      <div className="flex items-center gap-2 mb-2">
        <Network size={14} className="text-accent" />
        <h3 className="text-sm font-semibold text-fg">Network</h3>
        <span className="ml-auto text-[10px] text-fg-faint">{rows.length} vars</span>
      </div>
      <p className="text-xs text-fg-muted mb-3">
        Port and bind address are preflight settings read when the server starts. You can stage them here, then restart to apply them. Other network controls are postflight runtime settings; restart badges mark exceptions.
      </p>

      {restartNeeded && (
        <div className="mb-3 px-3 py-2 rounded-lg border border-amber-700/50 bg-amber-900/20 text-amber-700 dark:text-amber-300 text-xs flex items-center gap-2">
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
        <p className="text-xs text-red-400 mb-2">{error}</p>
      )}

      {loading ? (
        <p className="text-xs text-fg-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-fg-muted">No network vars surfaced by the server.</p>
      ) : (
        <ul className="divide-y divide-border/30 rounded-lg border border-border/40 bg-surface">
          {rows.map((row) => (
            <NetworkSettingRow key={row.name} row={row} editing={editing} setEditing={setEditing} onSave={onSave} saving={saving} onReset={onReset} />
          ))}
        </ul>
      )}
    </div>
  );
}

function NetworkSettingRow({ row, editing, setEditing, onSave, saving, onReset }: {
  row: RuntimeEnvRow;
  editing: { name: string; value: string; } | null;
  setEditing: React.Dispatch<React.SetStateAction<{ name: string; value: string; } | null>>;
  onSave: () => void;
  saving: boolean;
  onReset: (row: RuntimeEnvRow) => void;
}) {
  return (
    <li key={row.name} className="px-3 py-2">
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
                onKeyDown={(event) => {
                  if (event.key === "Enter") onSave();
                  if (event.key === "Escape") setEditing(null);
                }}
                autoFocus
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
                onClick={() => setEditing(null)}
                className="px-2 py-1 rounded border border-border text-fg-faint hover:bg-surface-2 text-[11px]"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="mt-0.5 flex items-center gap-2 flex-wrap">
              <code className="text-[11px] font-mono text-fg-muted">{row.current}</code>
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
              onClick={() => setEditing({ name: row.name, value: row.current })}
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
