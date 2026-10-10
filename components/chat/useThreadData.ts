"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { Message, SummaryTopicSegment } from "@/api/types";
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
  hotSinceSeq: number | null;
  hotSinceSeqForRun: number | null | undefined;
  warmSummary: string | null;
  warmSummaryBefore: string | null;
  warmSummaryBeforeSeq: number | null;
  warmSummaryComputedAt: string | null;
  warmSummarySourceMessages: number | null;
  warmSummarySourceChars: number | null;
  warmSummaryTopics: SummaryTopicSegment[] | null;
  warmSummaryPending: boolean;
  compactionPending: boolean;
  contextWindowTokens: number | null;
  metaApplier: ThreadMetaApplier;
  loadOlder: () => Promise<void>;
  setContextPin: (next: number | null) => Promise<void>;
}

export function useThreadData({ threadId, attach }: Params): ThreadDataApi {
  const [messages, setMessages] = useState<Message[]>([]);
  const [notices, setNotices] = useState<SystemNotice[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [metadataThreadId, setMetadataThreadId] = useState<string | null>(null);
  const [hotSince, setHotSince] = useState<string | null>(null);
  const [hotSinceSeq, setHotSinceSeq] = useState<number | null>(null);
  const [warmSummary, setWarmSummary] = useState<string | null>(null);
  const [warmSummaryBefore, setWarmSummaryBefore] = useState<string | null>(null);
  const [warmSummaryBeforeSeq, setWarmSummaryBeforeSeq] = useState<number | null>(null);
  const [warmSummaryComputedAt, setWarmSummaryComputedAt] = useState<string | null>(null);
  const [warmSummarySourceMessages, setWarmSummarySourceMessages] = useState<number | null>(null);
  const [warmSummarySourceChars, setWarmSummarySourceChars] = useState<number | null>(null);
  const [warmSummaryTopics, setWarmSummaryTopics] = useState<SummaryTopicSegment[] | null>(null);
  const [warmSummaryPending, setWarmSummaryPending] = useState(false);
  const [compactionPending, setCompactionPending] = useState(false);
  const [contextWindowTokens, setContextWindowTokens] = useState<number | null>(null);

  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const metadataMatchesThread = metadataThreadId === threadId;

  const metaApplier: ThreadMetaApplier = {
    setHotSince, setHotSinceSeq, setWarmSummary, setWarmSummaryBefore, setWarmSummaryBeforeSeq,
    setWarmSummaryComputedAt, setWarmSummarySourceMessages,
    setWarmSummarySourceChars, setContextWindowTokens, setWarmSummaryPending,
    setCompactionPending, setWarmSummaryTopics,
  };

  const addNotice = useCallback((text: string) => {
    setNotices((p) => [...p, { id: `notice-${Date.now()}`, text }]);
  }, []);

  useEffect(() => {
    if (!threadId) {
      setMetadataThreadId(null);
      setMessages([]);
      setNotices([]);
      setHasMore(false);
      setMessagesLoading(false);
      setHotSince(null);
      setHotSinceSeq(null);
      setWarmSummary(null);
      setWarmSummaryBefore(null);
      setWarmSummaryBeforeSeq(null);
      setWarmSummaryComputedAt(null);
      setWarmSummarySourceMessages(null);
      setWarmSummarySourceChars(null);
      setWarmSummaryTopics(null);
      setWarmSummaryPending(false);
      setCompactionPending(false);
      setContextWindowTokens(null);
      return;
    }
    let cancelled = false;
    setMetadataThreadId(null);
    setMessagesLoading(true);
    setMessages([]);
    setHasMore(false);
    setHotSince(null);
    setHotSinceSeq(null);
    setWarmSummary(null);
    setWarmSummaryBefore(null);
    setWarmSummaryBeforeSeq(null);
    setWarmSummaryComputedAt(null);
    setWarmSummarySourceMessages(null);
    setWarmSummarySourceChars(null);
    setWarmSummaryTopics(null);
    setWarmSummaryPending(false);
    setCompactionPending(false);
    setContextWindowTokens(null);
    api.threads.get(threadId).then((d) => {
      if (cancelled) return;
      setMessages(d.messages);
      setHasMore(d.has_more);
      applyThreadMeta(metaApplier, d);
      setMetadataThreadId(threadId);
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

  // ADR-0042. Keep the current boundary visible while the server prepares
  // and atomically publishes the replacement warm context plus new pin.
  const setContextPin = useCallback(async (next: number | null) => {
    if (!threadId) return;
    if (next === null) {
      setHotSince(null);
      setHotSinceSeq(null);
    }
    setCompactionPending(next !== null);
    try {
      const updated = await api.threads.setContextPin(threadId, next);
      setHotSince(updated.hot_since);
      setHotSinceSeq(updated.hot_since_seq);
      setWarmSummary(updated.warm_summary);
      setWarmSummaryBefore(updated.warm_summary_before);
      setWarmSummaryBeforeSeq(updated.warm_summary_before_seq);
      setWarmSummaryComputedAt(updated.warm_summary_computed_at);
      setWarmSummarySourceMessages(updated.warm_summary_source_messages);
      setWarmSummarySourceChars(updated.warm_summary_source_chars);
      setWarmSummaryTopics(updated.warm_summary_topics);
      setCompactionPending(updated.pending_hot_since_seq != null);
      const summaryFresh = updated.hot_since_seq != null
        && updated.warm_summary_before_seq === updated.hot_since_seq;
      if (!updated.pending_hot_since_seq && (!updated.hot_since_seq || summaryFresh)) {
        setWarmSummaryPending(false);
      }
    } catch (err) {
      setWarmSummaryPending(false);
      setCompactionPending(false);
      console.error("setContextPin failed", err);
    }
  }, [threadId]);

  useEffect(() => {
    if (!threadId) return;
    const summaryFresh = hotSinceSeq !== null && warmSummaryBeforeSeq === hotSinceSeq;
    const summaryStale = warmSummaryPending && hotSinceSeq !== null && !summaryFresh;
    if (!summaryStale && !compactionPending) {
      if (warmSummaryPending && hotSinceSeq !== null && summaryFresh) setWarmSummaryPending(false);
      return;
    }
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api.threads.get(threadId).then((d) => {
        if (cancelled) return;
        applyThreadMeta(metaApplier, d);
        const refreshedSummaryIsFresh = d.hot_since_seq != null
          && d.warm_summary_before_seq === d.hot_since_seq;
        if (!d.hot_since_seq || refreshedSummaryIsFresh) {
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
  }, [threadId, warmSummaryPending, compactionPending, hotSince, hotSinceSeq, warmSummaryBefore, warmSummaryBeforeSeq]);

  const loadOlder = useCallback(async () => {
    if (!threadId || loadingMore || !hasMore || messages.length === 0) return;
    setLoadingMore(true);
    try {
      const oldest = messages[0].seq;
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
    hotSince: metadataMatchesThread ? hotSince : null,
    hotSinceSeq: metadataMatchesThread ? hotSinceSeq : null,
    hotSinceSeqForRun: metadataMatchesThread ? hotSinceSeq : undefined,
    warmSummary, warmSummaryBefore, warmSummaryBeforeSeq, warmSummaryComputedAt,
    warmSummarySourceMessages, warmSummarySourceChars, warmSummaryTopics, warmSummaryPending, compactionPending, contextWindowTokens,
    metaApplier, loadOlder, setContextPin,
  };
}
