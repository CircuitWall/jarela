"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Edit3, RotateCcw, Save, ServerCog, Search, X } from "lucide-react";
import { refreshRuntimeConfig } from "@/api/runtime-config";

interface EnvRow {
  name: string;
  type: "int" | "string" | "bool" | "enum";
  default: number | string | boolean;
  current: string;
  overridden: boolean;
  description: string;
  category: string;
  tier: "A" | "B" | "C";
  requiresRestart: boolean;
  agentWritable: boolean;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
}

const CATEGORY_LABEL: Record<string, string> = {
  network: "Network",
  agent: "Agent",
  tools: "Tools",
  lifecycle: "Lifecycle",
  limits: "Limits",
  logging: "Logging",
  scheduler: "Scheduler",
  documents: "Documents",
  ui: "UI",
};

const CATEGORY_ORDER = [
  "network",
  "agent",
  "tools",
  "lifecycle",
  "logging",
  "limits",
  "scheduler",
  "documents",
  "ui",
];

/**
 * Edit-runtime-overrides panel. Lists every JARELA_* var the schema knows
 * about, lets the user override any of them (persisted to
 * ~/.jarela/env-overrides.json), and surfaces a Restart button when the
 * pending changes flag a requiresRestart=true row.
 */
export function EnvVarsPanel() {
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [editing, setEditing] = useState<{ name: string; value: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const editInputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/v1/env", { cache: "no-store" });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const body = (await r.json()) as { entries: EnvRow[] };
      setRows(body.entries);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Focus the edit input when it appears.
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
    const m = new Map<string, EnvRow[]>();
    for (const cat of CATEGORY_ORDER) m.set(cat, []);
    for (const row of filtered) {
      if (!m.has(row.category)) m.set(row.category, []);
      m.get(row.category)!.push(row);
    }
    return Array.from(m.entries()).filter(([, list]) => list.length > 0);
  }, [filtered]);

  const startEdit = useCallback((row: EnvRow) => {
    setEditing({ name: row.name, value: row.current });
  }, []);

  const cancelEdit = useCallback(() => setEditing(null), []);

  const persist = useCallback(async (name: string, value: string | null, requiresRestart: boolean) => {
    setSaving(true);
    try {
      const r = await fetch("/api/v1/env", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, value }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${r.status} ${r.statusText}`);
      }
      if (requiresRestart) setRestartNeeded(true);
      // Re-fetch the public runtime-config snapshot so api/client.ts and
      // any other browser-side reader picks up the new HTTP / SSE / health
      // timeouts on the next call.
      refreshRuntimeConfig();
      await load();
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [load]);

  const onSave = useCallback(() => {
    if (!editing) return;
    const row = rows.find((r) => r.name === editing.name);
    if (!row) return;
    void persist(editing.name, editing.value, row.requiresRestart);
  }, [editing, rows, persist]);

  const onReset = useCallback((row: EnvRow) => {
    void persist(row.name, null, row.requiresRestart);
  }, [persist]);

  const onRestart = useCallback(async () => {
    if (!confirm("Restart the server? In-flight runs will be aborted; the supervisor (launchd / systemd / Task Scheduler) will relaunch the process.")) {
      return;
    }
    setRestarting(true);
    try {
      await fetch("/api/v1/system/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "user clicked Restart in EnvVarsPanel" }),
      });
      // The server will exit ~250ms after returning. Show a banner and
      // poll /health until it comes back.
      pollUntilUp().then(() => {
        setRestarting(false);
        setRestartNeeded(false);
        void load();
      }).catch(() => {
        setRestarting(false);
        setError("Server didn't come back within 30s — check it manually.");
      });
    } catch (e) {
      setRestarting(false);
      setError((e as Error).message);
    }
  }, [load]);

  return (
    <div className="flex flex-col h-full min-h-0 p-4 gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-medium text-fg">Environment</h2>
        <span className="text-[10px] text-fg-faint">{rows.length} vars</span>
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
                {CATEGORY_LABEL[category] ?? category}
              </div>
              <ul className="divide-y divide-border/30">
                {list.map((row) => (
                  <li key={row.name} className="px-3 py-2 hover:bg-surface-2/40">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <code className="text-[12px] font-mono text-fg">{row.name}</code>
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
                            {row.type === "enum" && row.enumValues ? (
                              <select
                                ref={(el) => { editInputRef.current = el; }}
                                value={editing.value}
                                onChange={(e) => setEditing({ name: row.name, value: e.target.value })}
                                className="px-2 py-1 rounded border border-border bg-surface text-fg text-[11px] font-mono"
                              >
                                {row.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
                              </select>
                            ) : row.type === "bool" ? (
                              <select
                                ref={(el) => { editInputRef.current = el; }}
                                value={editing.value}
                                onChange={(e) => setEditing({ name: row.name, value: e.target.value })}
                                className="px-2 py-1 rounded border border-border bg-surface text-fg text-[11px] font-mono"
                              >
                                <option value="true">true</option>
                                <option value="false">false</option>
                              </select>
                            ) : (
                              <input
                                ref={(el) => { editInputRef.current = el; }}
                                type={row.type === "int" ? "number" : "text"}
                                value={editing.value}
                                onChange={(e) => setEditing({ name: row.name, value: e.target.value })}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") onSave();
                                  if (e.key === "Escape") cancelEdit();
                                }}
                                min={row.min}
                                max={row.max}
                                className="px-2 py-1 rounded border border-border bg-surface text-fg text-[11px] font-mono w-48"
                              />
                            )}
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
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

async function pollUntilUp(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 500;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, delay));
    delay = Math.min(2000, Math.floor(delay * 1.4));
    try {
      const r = await fetch("/api/v1/health", { cache: "no-store" });
      if (r.ok) return;
    } catch { /* still down */ }
  }
  throw new Error("server did not return");
}
