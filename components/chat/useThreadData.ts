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
  warmSummarySourceMessages: number | null;
  warmSummarySourceChars: number | null;
  warmSummaryPending: boolean;
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
  const [warmSummarySourceMessages, setWarmSummarySourceMessages] = useState<number | null>(null);
  const [warmSummarySourceChars, setWarmSummarySourceChars] = useState<number | null>(null);
  const [warmSummaryPending, setWarmSummaryPending] = useState(false);
  const [contextWindowTokens, setContextWindowTokens] = useState<number | null>(null);

  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  const metaApplier: ThreadMetaApplier = {
    setHotSince, setWarmSummary, setWarmSummaryBefore,
    setWarmSummaryComputedAt, setWarmSummarySourceMessages,
    setWarmSummarySourceChars, setContextWindowTokens, setWarmSummaryPending,
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
      setWarmSummarySourceMessages(null);
      setWarmSummarySourceChars(null);
      setWarmSummaryPending(false);
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
    setWarmSummarySourceMessages(null);
    setWarmSummarySourceChars(null);
    setWarmSummaryPending(false);
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
  // chrome reacts instantly; PATCH then confirms server-side. Keep the
  // previous summary visible while the new one recomputes so users retain
  // continuity instead of seeing an empty placeholder.
  const setContextPin = useCallback(async (next: string | null) => {
    if (!threadId) return;
    setHotSince(next);
    setWarmSummaryPending(!!next);
    try {
      const updated = await api.threads.setContextPin(threadId, next);
      setHotSince(updated.hot_since);
      setWarmSummary(updated.warm_summary);
      setWarmSummaryBefore(updated.warm_summary_before);
      setWarmSummaryComputedAt(updated.warm_summary_computed_at);
      setWarmSummarySourceMessages(updated.warm_summary_source_messages);
      setWarmSummarySourceChars(updated.warm_summary_source_chars);
      if (!updated.hot_since || updated.warm_summary_before === updated.hot_since) {
        setWarmSummaryPending(false);
      }
    } catch (err) {
      setWarmSummaryPending(false);
      console.error("setContextPin failed", err);
    }
  }, [threadId]);

  useEffect(() => {
    if (!threadId || !warmSummaryPending || !hotSince) return;
    if (warmSummaryBefore === hotSince) {
      setWarmSummaryPending(false);
      return;
    }
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api.threads.get(threadId).then((d) => {
        if (cancelled) return;
        applyThreadMeta(metaApplier, d);
        if (!d.hot_since || d.warm_summary_before === d.hot_since) {
          setWarmSummaryPending(false);
        }
      }).catch((err) => {
        if (!cancelled) console.error("warm summary refresh poll failed", err);
      });
    }, 1600);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, warmSummaryPending, hotSince, warmSummaryBefore]);

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
    hotSince, warmSummary, warmSummaryBefore, warmSummaryComputedAt,
    warmSummarySourceMessages, warmSummarySourceChars, warmSummaryPending, contextWindowTokens,
    metaApplier, loadOlder, setContextPin,
  };
}
