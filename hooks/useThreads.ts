"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import type { ThreadSummary } from "@/api/types";

export function useThreads() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setThreads(await api.threads.list()); } finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const createThread = useCallback(async (agentId: string): Promise<ThreadSummary> => {
    const t = await api.threads.create(agentId);
    setThreads((p) => [t, ...p]);
    return t;
  }, []);

  const deleteThread = useCallback(async (threadId: string) => {
    await api.threads.delete(threadId);
    setThreads((p) => p.filter((t) => t.thread_id !== threadId));
  }, []);

  return { threads, loading, refresh, createThread, deleteThread };
}
