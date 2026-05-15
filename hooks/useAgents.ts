"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, AgentConfigIn } from "@/api/types";

export function useAgents() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setAgents(await api.agents.list());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const create = useCallback(async (data: AgentConfigIn) => {
    const a = await api.agents.create(data);
    setAgents((p) => [...p, a]);
    return a;
  }, []);

  const update = useCallback(async (id: string, data: AgentConfigIn) => {
    const a = await api.agents.update(id, data);
    setAgents((p) => p.map((x) => (x.id === id ? a : x)));
    return a;
  }, []);

  const remove = useCallback(async (id: string) => {
    await api.agents.delete(id);
    setAgents((p) => p.filter((x) => x.id !== id));
  }, []);

  return { agents, loading, refresh, create, update, remove };
}
