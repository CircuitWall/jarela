"use client";
import { useEffect, useRef } from "react";
import { reportError } from "@/lib/ui/error-message";

interface Params {
  sessionError?: string | null;
  streamError: string | null | undefined;
  agentId: string | null;
  threadId: string | null;
}

// Surface session-load and stream errors as toasts instead of disabling the
// input or rendering an inline red banner. Toasts are dismissible,
// dedupe-by-id, and carry the Report path. The chat stays interactive so
// the user can retry without reloading.
export function useChatErrorReporting({ sessionError, streamError, agentId, threadId }: Params) {
  const lastSessionErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionError) { lastSessionErrorRef.current = null; return; }
    if (lastSessionErrorRef.current === sessionError) return;
    lastSessionErrorRef.current = sessionError;
    reportError({
      error: sessionError,
      fallbackTitle: "Couldn't load session",
      summary: "The agent's thread didn't load. Retry by re-selecting the agent.",
      context: { agent_id: agentId, panel: "chat", action: "session.load" },
    });
  }, [sessionError, agentId]);

  const lastStreamErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!streamError) { lastStreamErrorRef.current = null; return; }
    if (lastStreamErrorRef.current === streamError) return;
    lastStreamErrorRef.current = streamError;
    reportError({
      error: streamError,
      fallbackTitle: "Chat stream error",
      context: { agent_id: agentId, thread_id: threadId, panel: "chat", action: "stream" },
    });
  }, [streamError, agentId, threadId]);
}
