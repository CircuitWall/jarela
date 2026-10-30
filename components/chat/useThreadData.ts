"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
import type { Message, SummaryTopicSegment, WarmChannelSummary } from "@/api/types";
import { applyThreadMeta, type ThreadMetaApplier } from "./chat-helpers";

interface Params {
  threadId: string | null;
  attach: (threadId: string) => Promise<unknown>;
}

interface ThreadMetadata {
  hotSince: string | null;
  hotSinceSeq: number | null;
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
}

export interface ThreadDataApi extends ThreadMetadata {
  messages: Message[];
  messagesThreadId: string | null;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  messagesRef: React.MutableRefObject<Message[]>;
  hasMore: boolean;
  setHasMore: React.Dispatch<React.SetStateAction<boolean>>;
  loadingMore: boolean;
  messagesLoading: boolean;
  hotSinceSeqForRun: number | null | undefined;
  metaApplier: ThreadMetaApplier;
  loadOlder: () => Promise<void>;
  setContextPin: (next: number | null) => Promise<void>;
}

function emptyThreadMetadata(): ThreadMetadata {
  return {
    hotSince: null,
    hotSinceSeq: null,
    warmSummary: null,
    warmSummaryBefore: null,
    warmSummaryBeforeSeq: null,
    warmSummaryComputedAt: null,
    warmSummarySourceMessages: null,
    warmSummarySourceChars: null,
    warmSummaryTopics: null,
    warmChannelSummaries: [],
    warmSummaryPending: false,
    compactionPending: false,
    manualCompactionPending: false,
    contextWindowTokens: null,
  };
}

function useThreadMetadata(threadId: string | null) {
  const [value, setValue] = useState(emptyThreadMetadata);
  const [metadataThreadId, setMetadataThreadId] = useState<string | null>(null);
  const metaApplier = useMemo<ThreadMetaApplier>(() => {
    const setter = <K extends keyof ThreadMetadata>(key: K) => (next: ThreadMetadata[K]) => {
      setValue((previous) => ({ ...previous, [key]: next }));
    };
    return {
      setHotSince: setter("hotSince"),
      setHotSinceSeq: setter("hotSinceSeq"),
      setWarmSummary: setter("warmSummary"),
      setWarmSummaryBefore: setter("warmSummaryBefore"),
      setWarmSummaryBeforeSeq: setter("warmSummaryBeforeSeq"),
      setWarmSummaryComputedAt: setter("warmSummaryComputedAt"),
      setWarmSummarySourceMessages: setter("warmSummarySourceMessages"),
      setWarmSummarySourceChars: setter("warmSummarySourceChars"),
      setWarmSummaryTopics: setter("warmSummaryTopics"),
      setWarmChannelSummaries: setter("warmChannelSummaries"),
      setWarmSummaryPending: setter("warmSummaryPending"),
      setCompactionPending: setter("compactionPending"),
      setManualCompactionPending: setter("manualCompactionPending"),
      setContextWindowTokens: setter("contextWindowTokens"),
    };
  }, []);
  const reset = useCallback(() => {
    setMetadataThreadId(null);
    setValue(emptyThreadMetadata());
  }, []);
  const setContextPin = useCallback(async (next: number | null) => {
    if (!threadId) return;
    if (next === null) {
      metaApplier.setHotSince(null);
      metaApplier.setHotSinceSeq(null);
    }
    metaApplier.setCompactionPending?.(next !== null);
    try {
      const updated = await api.threads.setContextPin(threadId, next);
      const summaryFresh = updated.hot_since_seq != null
        && updated.warm_summary_before_seq === updated.hot_since_seq;
      setValue((previous) => ({
        ...previous,
        hotSince: updated.hot_since,
        hotSinceSeq: updated.hot_since_seq,
        warmSummary: updated.warm_summary,
        warmSummaryBefore: updated.warm_summary_before,
        warmSummaryBeforeSeq: updated.warm_summary_before_seq,
        warmSummaryComputedAt: updated.warm_summary_computed_at,
        warmSummarySourceMessages: updated.warm_summary_source_messages,
        warmSummarySourceChars: updated.warm_summary_source_chars,
        warmSummaryTopics: updated.warm_summary_topics,
        warmChannelSummaries: updated.warm_channel_summaries ?? [],
        compactionPending: updated.pending_hot_since_seq != null,
        warmSummaryPending: !updated.pending_hot_since_seq && (!updated.hot_since_seq || summaryFresh)
          ? false : previous.warmSummaryPending,
      }));
    } catch (err) {
      metaApplier.setWarmSummaryPending?.(false);
      metaApplier.setCompactionPending?.(false);
      console.error("setContextPin failed", err);
    }
  }, [threadId, metaApplier]);
  return { value, metaApplier, reset, setMetadataThreadId, setContextPin, matchesThread: metadataThreadId === threadId };
}

export function useThreadData({ threadId, attach }: Params): ThreadDataApi {
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesThreadId, setMessagesThreadId] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const { value, metaApplier, reset, setMetadataThreadId, setContextPin, matchesThread } = useThreadMetadata(threadId);

  useEffect(() => {
    reset();
    setMessages([]);
    setHasMore(false);
    if (!threadId) {
      setMessagesThreadId(null);
      setMessagesLoading(false);
      return;
    }
    let cancelled = false;
    setMessagesLoading(true);
    api.threads.get(threadId, { startup: true }).then((data) => {
      if (cancelled) return;
      setMessages(data.messages);
      setHasMore(data.has_more);
      applyThreadMeta(metaApplier, data);
      setMetadataThreadId(threadId);
    }).catch((err) => { if (!cancelled) console.error(err); })
      .finally(() => {
        if (cancelled) return;
        setMessagesLoading(false);
        setMessagesThreadId(threadId);
        // Completion of attach, not history loading, owns queue draining.
        attach(threadId).catch(() => { /* best-effort */ });
      });
    return () => { cancelled = true; };
  }, [threadId, attach, metaApplier, reset, setMetadataThreadId]);

  const loadOlder = useCallback(async () => {
    if (!threadId || loadingMore || !hasMore || messages.length === 0) return;
    setLoadingMore(true);
    try {
      const oldest = messages[0].seq;
      const data = await api.threads.get(threadId, { before: oldest, limit: 50 });
      setMessages((previous) => [...data.messages, ...previous]);
      setHasMore(data.has_more);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingMore(false);
    }
    // Streaming appends must not recreate this callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, loadingMore, hasMore, messages.length]);

  return {
    ...value,
    messages,
    messagesThreadId,
    setMessages,
    messagesRef,
    hasMore,
    setHasMore,
    loadingMore,
    messagesLoading: Boolean(threadId) && (messagesLoading || messagesThreadId !== threadId),
    hotSince: matchesThread ? value.hotSince : null,
    hotSinceSeq: matchesThread ? value.hotSinceSeq : null,
    hotSinceSeqForRun: matchesThread ? value.hotSinceSeq : undefined,
    metaApplier,
    loadOlder,
    setContextPin,
  };
}
