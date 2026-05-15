"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import type { ModelConfig, ModelConfigIn, TaskAssignment, ToolPolicy } from "@/api/types";

export function useModels() {
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [assignments, setAssignments] = useState<TaskAssignment[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [m, a] = await Promise.all([api.models.list(), api.tasks.list()]);
      setModels(m);
      setAssignments(a);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const create = useCallback(async (name: string, data: ModelConfigIn) => {
    const m = await api.models.create(name, data);
    setModels((p) => [...p, m]);
    return m;
  }, []);

  const update = useCallback(async (name: string, data: ModelConfigIn) => {
    const m = await api.models.update(name, data);
    setModels((p) => p.map((x) => (x.name === name ? m : x)));
    return m;
  }, []);

  const remove = useCallback(async (name: string) => {
    await api.models.delete(name);
    setModels((p) => p.filter((x) => x.name !== name));
  }, []);

  const assign = useCallback(async (agent_id: string, model_config_name: string, tool_policy?: ToolPolicy) => {
    const a = await api.tasks.assign(agent_id, model_config_name, tool_policy);
    setAssignments((p) => {
      const exists = p.find((x) => x.agent_id === agent_id);
      return exists ? p.map((x) => (x.agent_id === agent_id ? a : x)) : [...p, a];
    });
    return a;
  }, []);

  const unassign = useCallback(async (agent_id: string) => {
    await api.tasks.unassign(agent_id);
    setAssignments((p) => p.filter((x) => x.agent_id !== agent_id));
  }, []);

  return { models, assignments, loading, refresh, create, update, remove, assign, unassign };
}
