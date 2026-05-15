import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { MemoryItem } from "../api/types";

export function useMemory(namespace?: string, search?: string) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.memory.list(namespace, search);
      setItems(data);
    } finally {
      setLoading(false);
    }
  }, [namespace, search]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = useCallback(async (ns: string, key: string, value: unknown) => {
    const item = await api.memory.create(ns, key, value);
    setItems((prev) => [item, ...prev]);
    return item;
  }, []);

  const update = useCallback(async (ns: string, key: string, value: unknown) => {
    const item = await api.memory.update(ns, key, value);
    setItems((prev) => prev.map((i) => (i.namespace === ns && i.key === key ? item : i)));
    return item;
  }, []);

  const remove = useCallback(async (ns: string, key: string) => {
    await api.memory.delete(ns, key);
    setItems((prev) => prev.filter((i) => !(i.namespace === ns && i.key === key)));
  }, []);

  return { items, loading, refresh, create, update, remove };
}
