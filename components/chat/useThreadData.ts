"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { Message } from "@/api/types";
import { applyThreadMeta, type SystemNotice, type ThreadMetaApplier } from "./chat-helpers";

interface Params {
  threadId: string | null;
  attach: (threadId: string) => Promise<unknown>;
}

export interface ThreadDataApi {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  messagesRef: React.MutableRefObject<Message[]>;
  notices: SystemNotice[];
  setNotices: React.Dispatch<React.SetStateAction<SystemNotice[]>>;
  addNotice: (text: string) => void;
  hasMore: boolean;
  setHasMore: React.Dispatch<React.SetStateAction<boolean>>;
  loadingMore: boolean;
  messagesLoading: boolean;
  hotSince: string | null;
  warmSummary: string | null;
  warmSummaryBefore: string | null;
  warmSummaryComputedAt: string | null;
  contextWindowTokens: number | null;
  metaApplier: ThreadMetaApplier;
  loadOlder: () => Promise<void>;
  setContextPin: (next: string | null) => Promise<void>;
}

export function useThreadData({ threadId, attach }: Params): ThreadDataApi {
  const [messages, setMessages] = useState<Message[]>([]);
  const [notices, setNotices] = useState<SystemNotice[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [hotSince, setHotSince] = useState<string | null>(null);
  const [warmSummary, setWarmSummary] = useState<string | null>(null);
  const [warmSummaryBefore, setWarmSummaryBefore] = useState<string | null>(null);
  const [warmSummaryComputedAt, setWarmSummaryComputedAt] = useState<string | null>(null);
  const [contextWindowTokens, setContextWindowTokens] = useState<number | null>(null);

  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  const metaApplier: ThreadMetaApplier = {
    setHotSince, setWarmSummary, setWarmSummaryBefore,
    setWarmSummaryComputedAt, setContextWindowTokens,
  };

  const addNotice = useCallback((text: string) => {
    setNotices((p) => [...p, { id: `notice-${Date.now()}`, text }]);
  }, []);

  useEffect(() => {
    if (!threadId) {
      setMessages([]);
      setNotices([]);
      setHasMore(false);
      setMessagesLoading(false);
      setHotSince(null);
      setWarmSummary(null);
      setWarmSummaryBefore(null);
      setWarmSummaryComputedAt(null);
      setContextWindowTokens(null);
      return;
    }
    let cancelled = false;
    setMessagesLoading(true);
    setMessages([]);
    setHasMore(false);
    setHotSince(null);
    setWarmSummary(null);
    setWarmSummaryBefore(null);
    setWarmSummaryComputedAt(null);
    setContextWindowTokens(null);
    api.threads.get(threadId).then((d) => {
      if (cancelled) return;
      setMessages(d.messages);
      setHasMore(d.has_more);
      applyThreadMeta(metaApplier, d);
    }).catch((err) => { if (!cancelled) console.error(err); })
      .finally(() => {
        if (cancelled) return;
        setMessagesLoading(false);
        // Attach to any in-flight run for THIS thread. attach() sets
        // streaming=true optimistically and signals completion via onDone
        // (which drains the queue), so we must NOT fire drainQueueRef here.
        attach(threadId).catch(() => { /* best-effort */ });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, attach]);

  // ADR-0042. Move the user's boundary line. Optimistic update so the chat
  // chrome reacts instantly; PATCH then confirms server-side. Boundary
  // moves invalidate the cached summary — clear it locally too so the UI
  // shows a placeholder until the next run refreshes it.
  const setContextPin = useCallback(async (next: string | null) => {
    if (!threadId) return;
    setHotSince(next);
    if (warmSummaryBefore !== next) {
      setWarmSummary(null);
      setWarmSummaryBefore(null);
      setWarmSummaryComputedAt(null);
    }
    try {
      const updated = await api.threads.setContextPin(threadId, next);
      setHotSince(updated.hot_since);
      setWarmSummary(updated.warm_summary);
      setWarmSummaryBefore(updated.warm_summary_before);
      setWarmSummaryComputedAt(updated.warm_summary_computed_at);
    } catch (err) {
      console.error("setContextPin failed", err);
    }
  }, [threadId, warmSummaryBefore]);

  const loadOlder = useCallback(async () => {
    if (!threadId || loadingMore || !hasMore || messages.length === 0) return;
    setLoadingMore(true);
    try {
      const oldest = messages[0].created_at;
      const d = await api.threads.get(threadId, { before: oldest, limit: 50 });
      setMessages((prev) => [...d.messages, ...prev]);
      setHasMore(d.has_more);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingMore(false);
    }
    // Depend on `messages.length` rather than the array identity so streaming
    // appends don't recreate this callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, loadingMore, hasMore, messages.length]);

  return {
    messages, setMessages, messagesRef, notices, setNotices, addNotice,
    hasMore, setHasMore, loadingMore, messagesLoading,
    hotSince, warmSummary, warmSummaryBefore, warmSummaryComputedAt, contextWindowTokens,
    metaApplier, loadOlder, setContextPin,
  };
}
