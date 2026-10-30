"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { refreshRuntimeConfig } from "@/api/runtime-config";
import { confirmAction } from "@/lib/ui/confirm";
import type { EnvCategory } from "@/lib/env/schema";
import { errorMessage } from "@/lib/utils/error";

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
  const lifecycle = useRef<AbortController | null>(null);
  const pendingRestart = useRef<AbortSignal | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const r = await fetch("/api/v1/env", { cache: "no-store", signal });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const body = (await r.json()) as { entries: RuntimeEnvRow[] };
      signal.throwIfAborted();
      setRows(body.entries.filter((row) => (scope === "network" ? row.category === "network" : row.category !== "network")));
      setError(null);
      return true;
    } catch (e) {
      if (!signal.aborted) setError(errorMessage(e));
      return false;
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    setLoading(true);
    setRows([]);
    setEditing(null);
    setSaving(false);
    setRestarting(false);
    void load(controller.signal);
    return () => {
      controller.abort();
      pendingRestart.current = null;
    };
  }, [load]);

  const persist = useCallback(async (name: string, value: string | null, requiresRestart: boolean) => {
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted) return;
    setSaving(true);
    try {
      const r = await fetch("/api/v1/env", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, value }),
        signal,
      });
      await checkResponse(r);
      signal.throwIfAborted();
      if (requiresRestart) setRestartNeeded(true);
      refreshRuntimeConfig();
      if (await load(signal)) setEditing(null);
    } catch (e) {
      if (!signal.aborted) setError(errorMessage(e));
    } finally {
      if (!signal.aborted) setSaving(false);
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
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted || pendingRestart.current) return;
    pendingRestart.current = signal;
    try {
      const confirmed = await confirmAction({ message: "Restart the server? In-flight runs will be aborted; the supervisor (launchd / systemd / Task Scheduler) will relaunch the process.", destructive: true, confirmLabel: "Restart" });
      signal.throwIfAborted();
      if (!confirmed) {
        pendingRestart.current = null;
        return;
      }
      setRestarting(true);
      setError(null);
      const response = await fetch("/api/v1/system/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: restartReason }),
        signal,
      });
      await checkResponse(response);
      signal.throwIfAborted();
      void pollUntilUp(signal).then(async () => {
        signal.throwIfAborted();
        setRestartNeeded(false);
        await load(signal);
      }).catch((e: unknown) => {
        if (!signal.aborted) setError(errorMessage(e));
      }).finally(() => {
        if (!signal.aborted) {
          setRestarting(false);
          pendingRestart.current = null;
        }
      });
    } catch (e) {
      if (!signal.aborted) {
        setRestarting(false);
        pendingRestart.current = null;
        setError(errorMessage(e));
      }
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

async function checkResponse(response: Response): Promise<void> {
  if (response.ok) return;
  const body: unknown = await response.json().catch(() => null);
  const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
    ? body.error : `${response.status} ${response.statusText}`;
  throw new Error(message);
}

async function pollUntilUp(parent: AbortSignal): Promise<void> {
  parent.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(parent.reason);
  parent.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new Error("Server didn't come back within 30s — check it manually."));
  }, 30_000);
  const { signal } = controller;
  let delay = 500;
  try {
    while (true) {
      await waitForPoll(delay, signal);
      delay = Math.min(2000, Math.floor(delay * 1.4));
      try {
        const r = await fetch("/api/v1/health", { cache: "no-store", signal });
        signal.throwIfAborted();
        if (r.ok) return;
      } catch {
        signal.throwIfAborted();
      }
    }
  } finally {
    clearTimeout(timeout);
    parent.removeEventListener("abort", cancel);
  }
}

function waitForPoll(delay: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, delay);
    signal.addEventListener("abort", cancel, { once: true });
  });
}
