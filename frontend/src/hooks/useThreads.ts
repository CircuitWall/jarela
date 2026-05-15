import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { ThreadSummary } from "../api/types";

export function useThreads() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.threads.list();
      setThreads(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createThread = useCallback(
    async (agentId: string): Promise<ThreadSummary> => {
      const thread = await api.threads.create(agentId);
      setThreads((prev) => [thread, ...prev]);
      return thread;
    },
    []
  );

  const deleteThread = useCallback(async (threadId: string) => {
    await api.threads.delete(threadId);
    setThreads((prev) => prev.filter((t) => t.thread_id !== threadId));
  }, []);

  const updateThreadTitle = useCallback((threadId: string, title: string) => {
    setThreads((prev) =>
      prev.map((t) => (t.thread_id === threadId ? { ...t, title, updated_at: new Date().toISOString() } : t))
    );
  }, []);

  return { threads, loading, refresh, createThread, deleteThread, updateThreadTitle };
}
