"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { UnifiedHookResult } from "@/hooks/useListState";

export function useAgentSession(
  agentId: string | null,
  preferredThreadId?: string | null,
): UnifiedHookResult<
  { threadId: string | null; loading: boolean; error: string | null },
  { refresh: () => Promise<void> }
> {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!agentId) {
      setThreadId(null);
      setError(null);
      setLoading(false);
      return;
    }

    const mySeq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);

    try {
      // If the UI explicitly selected a thread (sidebar, toast, notification),
      // prefer it as long as it still belongs to this agent.
      if (preferredThreadId) {
        try {
          const d = await api.threads.get(preferredThreadId, { limit: 1 });
          if (mySeq !== requestSeqRef.current) return;
          if (d.agent_id === agentId) {
            setThreadId(preferredThreadId);
            return;
          }
        } catch {
          // Fallback to the agent's default thread below.
        }
      }

      const t = await api.agents.getThread(agentId);
      if (mySeq !== requestSeqRef.current) return;
      setThreadId(t.thread_id);
    } catch (err) {
      if (mySeq !== requestSeqRef.current) return;
      setError(String(err));
      console.error(err);
    } finally {
      if (mySeq !== requestSeqRef.current) return;
      setLoading(false);
    }
  }, [agentId, preferredThreadId]);

  useEffect(() => {
    // Critical: reset thread state immediately on agent change. Without this
    // the previous agent's threadId stays in state until the new fetch
    // resolves, and any consumer (ChatView, run attach, send) would briefly
    // operate on the wrong thread — sending messages to / loading messages
    // from agent A while the user is looking at agent B.
    setThreadId(null);
    setError(null);

    if (!agentId) {
      setLoading(false);
      return;
    }

    void refresh();

  }, [agentId, preferredThreadId, refresh]);

  const state = { threadId, loading, error };
  const commands = { refresh };

  return { state, commands, threadId, loading, error, refresh };
}
