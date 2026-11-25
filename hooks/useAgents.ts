"use client";
import { useCallback, useEffect, useRef } from "react";
import { api } from "@/api/client";
import type { AgentConfig, AgentConfigIn } from "@/api/types";
import { useListState, type UnifiedHookResult } from "@/hooks/useListState";

// Transient failures are expected while an installation update restarts the
// server. Retry with backoff and cache-busting before surfacing an error.
const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

export function useAgents(): UnifiedHookResult<
  { agents: AgentConfig[]; loading: boolean; error: string | null },
  {
    refresh: () => Promise<void>;
    create: (data: AgentConfigIn) => Promise<AgentConfig>;
    update: (id: string, data: Partial<AgentConfigIn>) => Promise<AgentConfig>;
    remove: (id: string) => Promise<void>;
    duplicate: (id: string) => Promise<AgentConfig>;
  }
> {
  const recoveryAttempts = useRef(0);
  const retryIndex = useRef(0);
  const emptyProbeStarted = useRef(false);
  const loader = useCallback(async () => {
    // After a failure, bypass both the in-memory cache and any stale
    // service-worker entry left by the previous installation.
    const recovering = recoveryAttempts.current > 0;
    const rows = await api.agents.list(recovering ? { force: true, cacheBust: true } : undefined);
    recoveryAttempts.current = 0;
    return rows;
  }, []);
  const {
    items: agents,
    setItems: setAgents,
    loading,
    error,
    refresh,
  } = useListState<AgentConfig>({
    loader,
    eventName: "jarela:agents-changed",
    initialLoading: true,
  });

  useEffect(() => {
    if (agents.length > 0 || !error) {
      retryIndex.current = 0;
      return;
    }
    // 423 is a lock state, not a transient network failure; the unlock
    // recovery path refreshes the list explicitly.
    if (error.startsWith("423")) return;
    if (retryIndex.current >= RETRY_DELAYS_MS.length) return;
    const delay = RETRY_DELAYS_MS[retryIndex.current];
    const timer = setTimeout(() => {
      retryIndex.current += 1;
      recoveryAttempts.current += 1;
      void refresh();
    }, delay);
    return () => clearTimeout(timer);
  }, [agents.length, error, refresh]);

  // A successful empty response can still be stale after an update: an older
  // service worker may have pinned an empty /agents entry. Probe once with a
  // cache-busted URL; only a genuinely empty server leaves the picker empty.
  useEffect(() => {
    if (loading || error || agents.length > 0 || emptyProbeStarted.current) return;
    emptyProbeStarted.current = true;
    void api.agents.list({ force: true, cacheBust: true })
      .then((rows) => {
        if (rows.length > 0 && typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("jarela:agents-changed"));
        }
      })
      .catch(() => {});
  }, [agents.length, error, loading]);

  const create = useCallback(async (data: AgentConfigIn) => {
    const a = await api.agents.create(data);
    setAgents((p) => [...p, a]);
    return a;
  }, [setAgents]);

  const update = useCallback(async (id: string, data: Partial<AgentConfigIn>) => {
    const a = await api.agents.update(id, data);
    setAgents((p) => p.map((x) => (x.id === id ? a : x)));
    return a;
  }, [setAgents]);

  const remove = useCallback(async (id: string) => {
    await api.agents.delete(id);
    setAgents((p) => p.filter((x) => x.id !== id));
  }, [setAgents]);

  const duplicate = useCallback(async (id: string) => {
    const a = await api.agents.duplicate(id);
    setAgents((p) => [...p, a]);
    return a;
  }, [setAgents]);

  const state = { agents, loading, error };
  const commands = { refresh, create, update, remove, duplicate };

  return { state, commands, agents, loading, error, refresh, create, update, remove, duplicate };
}
