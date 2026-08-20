"use client";

import { useCallback, useEffect, useState } from "react";
import { refreshRuntimeConfig } from "@/api/runtime-config";

export interface EnvSettingRow {
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

export function useEnvSettings() {
  const [rows, setRows] = useState<EnvSettingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/v1/env", { cache: "no-store" });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const body = (await r.json()) as { entries: EnvSettingRow[] };
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

  const save = useCallback(async (name: string, value: string | null) => {
    const r = await fetch("/api/v1/env", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, value }),
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `${r.status} ${r.statusText}`);
    }
    const body = (await r.json()) as { requiresRestart: boolean };
    refreshRuntimeConfig();
    await load();
    return body;
  }, [load]);

  return {
    rows,
    loading,
    error,
    setError,
    reload: load,
    save,
  };
}
