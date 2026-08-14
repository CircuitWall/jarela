"use client";
import { useCallback } from "react";
import { api } from "@/api/client";
import type { AgentConfig, AgentConfigIn } from "@/api/types";
import { useListState, type UnifiedHookResult } from "@/hooks/useListState";

export function useAgents(): UnifiedHookResult<
  { agents: AgentConfig[]; loading: boolean; error: string | null },
  {
    refresh: () => Promise<void>;
    create: (data: AgentConfigIn) => Promise<AgentConfig>;
    update: (id: string, data: AgentConfigIn) => Promise<AgentConfig>;
    remove: (id: string) => Promise<void>;
  }
> {
  const {
    items: agents,
    setItems: setAgents,
    loading,
    error,
    refresh,
  } = useListState<AgentConfig>({
    loader: () => api.agents.list(),
    eventName: "jarela:agents-changed",
  });

  const create = useCallback(async (data: AgentConfigIn) => {
    const a = await api.agents.create(data);
    setAgents((p) => [...p, a]);
    return a;
  }, [setAgents]);

  const update = useCallback(async (id: string, data: AgentConfigIn) => {
    const a = await api.agents.update(id, data);
    setAgents((p) => p.map((x) => (x.id === id ? a : x)));
    return a;
  }, [setAgents]);

  const remove = useCallback(async (id: string) => {
    await api.agents.delete(id);
    setAgents((p) => p.filter((x) => x.id !== id));
  }, [setAgents]);

  const state = { agents, loading, error };
  const commands = { refresh, create, update, remove };

  return { state, commands, agents, loading, error, refresh, create, update, remove };
}
