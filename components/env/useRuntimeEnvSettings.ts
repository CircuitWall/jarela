"use client";

import { useCallback, useEffect, useState } from "react";
import { refreshRuntimeConfig } from "@/api/runtime-config";
import { confirmAction } from "@/lib/ui/confirm";
import type { EnvCategory } from "@/lib/env/schema";

export interface RuntimeEnvRow {
  name: string;
  type: "int" | "string" | "bool" | "enum";
  default: number | string | boolean;
  current: string;
  overridden: boolean;
  description: string;
  category: EnvCategory;
  phase: "preflight" | "postflight";
  tier: "A" | "B" | "C";
  requiresRestart: boolean;
  agentWritable: boolean;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
}

export function useRuntimeEnvSettings(scope: "network" | "runtime", restartReason: string) {
  const [rows, setRows] = useState<RuntimeEnvRow[]>([]);
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
      const body = (await r.json()) as { entries: RuntimeEnvRow[] };
      setRows(body.entries.filter((row) => (scope === "network" ? row.category === "network" : row.category !== "network")));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [scope]);

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

  const onReset = useCallback((row: RuntimeEnvRow) => {
    void persist(row.name, null, row.requiresRestart);
  }, [persist]);

  const onRestart = useCallback(async () => {
    if (!(await confirmAction({ message: "Restart the server? In-flight runs will be aborted; the supervisor (launchd / systemd / Task Scheduler) will relaunch the process.", destructive: true, confirmLabel: "Restart" }))) {
      return;
    }
    setRestarting(true);
    try {
      await fetch("/api/v1/system/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: restartReason }),
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
  }, [load, restartReason]);

  return {
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
  };
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
