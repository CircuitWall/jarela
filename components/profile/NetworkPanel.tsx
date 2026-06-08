"use client";

import { useCallback, useEffect, useState } from "react";
import { Edit3, Network, RotateCcw, Save, ServerCog } from "lucide-react";
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

// Embedded network/proxy settings for the Profile page. Shows the
// `category === "network"` slice of /api/v1/env (bind host, port,
// HTTP/SSE timeouts, retry count) inline so the user doesn't need to
// open the full Environment panel to tune them. The same vars no
// longer appear in EnvVarsPanel.
export function NetworkPanel() {
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ name: string; value: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/v1/env", { cache: "no-store" });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const body = (await r.json()) as { entries: EnvRow[] };
      setRows(body.entries.filter((row) => row.category === "network"));
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
        body: JSON.stringify({ reason: "user clicked Restart in NetworkPanel" }),
      });
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
    <div className="rounded-xl border border-border bg-surface-2/70 p-4 mt-4">
      <div className="flex items-center gap-2 mb-2">
        <Network size={14} className="text-accent" />
        <h3 className="text-sm font-semibold text-fg">Network</h3>
        <span className="ml-auto text-[10px] text-fg-faint">{rows.length} vars</span>
      </div>
      <p className="text-xs text-fg-muted mb-3">
        Bind address, port, and HTTP timeouts. Changes to bind-time
        values require a server restart.
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
            <li key={row.name} className="px-3 py-2">
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
                  </div>
                  <div className="mt-0.5 text-[11px] text-fg-muted">{row.description}</div>
                  {editing?.name === row.name ? (
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <input
                        type={row.type === "int" ? "number" : "text"}
                        value={editing.value}
                        onChange={(e) => setEditing({ name: row.name, value: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") onSave();
                          if (e.key === "Escape") setEditing(null);
                        }}
                        min={row.min}
                        max={row.max}
                        autoFocus
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
          ))}
        </ul>
      )}
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
