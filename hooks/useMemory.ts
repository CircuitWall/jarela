"use client";
import { useCallback } from "react";
import { api } from "@/api/client";
import type { MemoryItem } from "@/api/types";
import { useListState, type UnifiedHookResult } from "@/hooks/useListState";

export function useMemory(namespace?: string, search?: string): UnifiedHookResult<
  { items: MemoryItem[]; loading: boolean; error: string | null },
  {
    refresh: () => Promise<void>;
    create: (ns: string, key: string, value: unknown) => Promise<MemoryItem>;
    update: (ns: string, key: string, value: unknown) => Promise<MemoryItem>;
    remove: (ns: string, key: string) => Promise<void>;
  }
> {
  const {
    items,
    setItems,
    loading,
    error,
    refresh,
  } = useListState<MemoryItem>({
    loader: () => api.memory.list(namespace, search),
  });

  const create = useCallback(async (ns: string, key: string, value: unknown) => {
    const item = await api.memory.create(ns, key, value);
    setItems((p) => [item, ...p]);
    return item;
  }, [setItems]);

  const update = useCallback(async (ns: string, key: string, value: unknown) => {
    const item = await api.memory.update(ns, key, value);
    setItems((p) => p.map((i) => (i.namespace === ns && i.key === key ? item : i)));
    return item;
  }, [setItems]);

  const remove = useCallback(async (ns: string, key: string) => {
    await api.memory.delete(ns, key);
    setItems((p) => p.filter((i) => !(i.namespace === ns && i.key === key)));
  }, [setItems]);

  const state = { items, loading, error };
  const commands = { refresh, create, update, remove };

  return { state, commands, items, loading, error, refresh, create, update, remove };
}
