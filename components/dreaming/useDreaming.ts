"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type {
  DreamKind,
  DreamingOverview,
  DreamingPatch,
  DreamingSettingsPatch,
  ModelConfig,
} from "@/api/types";
import { errorMessage } from "@/lib/utils/error";

export interface UseDreamingResult {
  overview: DreamingOverview | null;
  models: ModelConfig[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  saveSettings: (patch: DreamingSettingsPatch) => Promise<void>;
  setAgentEnabled: (agentId: string, enabled: boolean) => Promise<void>;
  dreamNow: (agentId: string, kind: DreamKind) => Promise<void>;
}

export function useDreaming(): UseDreamingResult {
  const [overview, setOverview] = useState<DreamingOverview | null>(null);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const next = await api.dreaming.getOverview();
      if (id === requestId.current) setOverview(next);
    } catch (err) {
      if (id === requestId.current) setError(errorMessage(err));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void api.models.list()
      .then((next) => { if (!cancelled) setModels(next.filter((model) => model.enabled !== false)); })
      .catch(() => { /* the model picker falls back to inherit */ });
    return () => { cancelled = true; };
  }, []);

  // A dream runs server-side; poll only while one is actually running. The
  // effect keys on the run's start time so a 2s poll does not restart itself
  // on every response.
  const runningSince = overview?.running?.started_at ?? null;
  useEffect(() => {
    if (!runningSince) return;
    const timer = setInterval(() => {
      void api.dreaming.getOverview()
        .then((next) => setOverview(next))
        .catch(() => undefined);
    }, 2_000);
    return () => clearInterval(timer);
  }, [runningSince]);

  const update = useCallback(async (patch: DreamingPatch) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.dreaming.update(patch);
      requestId.current += 1;
      setOverview(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const saveSettings = useCallback(
    (patch: DreamingSettingsPatch) => update({ settings: patch }),
    [update],
  );

  const setAgentEnabled = useCallback(
    (agentId: string, enabled: boolean) => update({ agent: { agent_id: agentId, enabled } }),
    [update],
  );

  const dreamNow = useCallback(async (agentId: string, kind: DreamKind) => {
    setBusy(true);
    setError(null);
    try {
      await api.dreaming.run({ agent_id: agentId, kind, force: true });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [load]);

  return { overview, models, loading, busy, error, refresh: load, saveSettings, setAgentEnabled, dreamNow };
}
