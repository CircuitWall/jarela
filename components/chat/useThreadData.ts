"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { Message, SummaryTopicSegment, WarmChannelSummary } from "@/api/types";
import { applyThreadMeta, type ThreadMetaApplier } from "./chat-helpers";

interface Params {
  threadId: string | null;
  attach: (threadId: string) => Promise<unknown>;
}

export interface ThreadDataApi {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  messagesRef: React.MutableRefObject<Message[]>;
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
  warmChannelSummaries: WarmChannelSummary[];
  warmSummaryPending: boolean;
  compactionPending: boolean;
  manualCompactionPending: boolean;
  contextWindowTokens: number | null;
  metaApplier: ThreadMetaApplier;
  loadOlder: () => Promise<void>;
  setContextPin: (next: number | null) => Promise<void>;
}

export function useThreadData({ threadId, attach }: Params): ThreadDataApi {
  const [messages, setMessages] = useState<Message[]>([]);
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
  const [warmChannelSummaries, setWarmChannelSummaries] = useState<WarmChannelSummary[]>([]);
  const [warmSummaryPending, setWarmSummaryPending] = useState(false);
  const [compactionPending, setCompactionPending] = useState(false);
  const [manualCompactionPending, setManualCompactionPending] = useState(false);
  const [contextWindowTokens, setContextWindowTokens] = useState<number | null>(null);

  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const metadataMatchesThread = metadataThreadId === threadId;

  const metaApplier: ThreadMetaApplier = {
    setHotSince, setHotSinceSeq, setWarmSummary, setWarmSummaryBefore, setWarmSummaryBeforeSeq,
    setWarmSummaryComputedAt, setWarmSummarySourceMessages,
    setWarmSummarySourceChars, setContextWindowTokens, setWarmSummaryPending,
    setCompactionPending, setManualCompactionPending, setWarmSummaryTopics, setWarmChannelSummaries,
  };

  useEffect(() => {
    if (!threadId) {
      setMetadataThreadId(null);
      setMessages([]);
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
      setWarmChannelSummaries([]);
      setWarmSummaryPending(false);
      setCompactionPending(false);
      setManualCompactionPending(false);
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
    setWarmChannelSummaries([]);
    setWarmSummaryPending(false);
    setCompactionPending(false);
    setManualCompactionPending(false);
    setContextWindowTokens(null);
    api.threads.get(threadId, { startup: true }).then((d) => {
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
      setWarmChannelSummaries(updated.warm_channel_summaries ?? []);
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
    messages, setMessages, messagesRef,
    hasMore, setHasMore, loadingMore, messagesLoading,
    hotSince: metadataMatchesThread ? hotSince : null,
    hotSinceSeq: metadataMatchesThread ? hotSinceSeq : null,
    hotSinceSeqForRun: metadataMatchesThread ? hotSinceSeq : undefined,
    warmSummary, warmSummaryBefore, warmSummaryBeforeSeq, warmSummaryComputedAt,
    warmSummarySourceMessages, warmSummarySourceChars, warmSummaryTopics, warmChannelSummaries, warmSummaryPending, compactionPending, manualCompactionPending, contextWindowTokens,
    metaApplier, loadOlder, setContextPin,
  };
}
