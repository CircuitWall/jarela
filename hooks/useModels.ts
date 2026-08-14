"use client";
import { useCallback } from "react";
import { api } from "@/api/client";
import type { ModelConfig, ModelConfigIn, TaskAssignment, ToolPolicy } from "@/api/types";
import { useListState } from "@/hooks/useListState";

export function useModels() {
  const {
    items: models,
    setItems: setModels,
    loading: modelsLoading,
    error: modelsError,
    refresh: refreshModels,
  } = useListState<ModelConfig>({
    loader: () => api.models.list(),
    eventName: "jarela:models-changed",
  });

  const {
    items: assignments,
    setItems: setAssignments,
    loading: assignmentsLoading,
    error: assignmentsError,
    refresh: refreshAssignments,
  } = useListState<TaskAssignment>({
    loader: () => api.tasks.list(),
    eventName: "jarela:models-changed",
  });

  const loading = modelsLoading || assignmentsLoading;
  const error = modelsError ?? assignmentsError;

  const refresh = useCallback(async () => {
    await Promise.all([refreshModels(), refreshAssignments()]);
  }, [refreshAssignments, refreshModels]);

  const create = useCallback(async (name: string, data: ModelConfigIn) => {
    const m = await api.models.create(name, data);
    setModels((p) => [...p, m]);
    return m;
  }, [setModels]);

  const update = useCallback(async (name: string, data: ModelConfigIn) => {
    const m = await api.models.update(name, data);
    setModels((p) => p.map((x) => (x.name === name ? m : x)));
    return m;
  }, [setModels]);

  const remove = useCallback(async (name: string): Promise<void> => {
    await api.models.delete(name);
    setModels((p) => p.filter((x) => x.name !== name));
    setAssignments((p) => p.filter((x) => x.model_config_name !== name));
  }, [setAssignments, setModels]);

  const assign = useCallback(async (agent_id: string, model_config_name: string, tool_policy?: ToolPolicy) => {
    const a = await api.tasks.assign(agent_id, model_config_name, tool_policy);
    setAssignments((p) => {
      const exists = p.find((x) => x.agent_id === agent_id);
      return exists ? p.map((x) => (x.agent_id === agent_id ? a : x)) : [...p, a];
    });
    return a;
  }, [setAssignments]);

  const unassign = useCallback(async (agent_id: string) => {
    await api.tasks.unassign(agent_id);
    setAssignments((p) => p.filter((x) => x.agent_id !== agent_id));
  }, [setAssignments]);

  const state = { models, assignments, loading, error };
  const commands = { refresh, create, update, remove, assign, unassign };

  return {
    state,
    commands,
    models,
    assignments,
    loading,
    error,
    refresh,
    create,
    update,
    remove,
    assign,
    unassign,
  };
}
