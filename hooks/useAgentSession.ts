"use client";
import { useEffect, useState } from "react";
import { api } from "@/api/client";

export function useAgentSession(agentId: string | null) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

    setLoading(true);
    let cancelled = false;
    api.agents
      .getThread(agentId)
      .then((t) => {
        if (cancelled) return;
        setThreadId(t.thread_id);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        console.error(err);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    // Cancel late responses if the user switches agents again before this
    // fetch resolves — otherwise the older fetch can overwrite the newer one.
    return () => { cancelled = true; };
  }, [agentId]);

  return { threadId, loading, error };
}
