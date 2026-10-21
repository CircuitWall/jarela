"use client";

import { useEffect, useRef } from "react";
import type { FirstRunChatKickoff, Tab } from "@/contexts/AppContext";

interface Params {
  kickoff: FirstRunChatKickoff | null;
  activeTab: Tab;
  agentId: string | null;
  threadId: string | null;
  sessionLoading: boolean;
  messagesLoading: boolean;
  messageCount: number;
  submit: (message: string, options: {
    quiet: true;
    messageMetadata: { hidden_from_chat: true };
  }) => Promise<void>;
  onConsumed: () => void;
  onError: (error: unknown) => void;
}

export function useFirstRunChatKickoff({
  kickoff,
  activeTab,
  agentId,
  threadId,
  sessionLoading,
  messagesLoading,
  messageCount,
  submit,
  onConsumed,
  onError,
}: Params): void {
  const handledId = useRef<string | null>(null);

  useEffect(() => {
    if (!kickoff || kickoff.agentId !== agentId || activeTab !== "chat") return;
    if (sessionLoading || !threadId || messagesLoading) return;
    if (messageCount > 0) {
      handledId.current = kickoff.id;
      onConsumed();
      return;
    }
    if (handledId.current === kickoff.id) return;

    handledId.current = kickoff.id;
    void submit(kickoff.message, { quiet: true, messageMetadata: { hidden_from_chat: true } }).catch((error) => {
      handledId.current = null;
      onError(error);
    });
  }, [
    activeTab,
    agentId,
    kickoff,
    messageCount,
    messagesLoading,
    onConsumed,
    onError,
    sessionLoading,
    submit,
    threadId,
  ]);
}