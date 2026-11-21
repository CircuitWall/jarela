"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Message } from "@/api/types";

export const IDLE_COMPACTION_DELAY_MS = 3 * 60 * 60 * 1000;

// Compacting a short exchange buys little and costs a model call, so the idle
// prompt only appears once the hot window carries a meaningful backlog.
export const IDLE_COMPACTION_MIN_HOT_MESSAGES = 10;

interface IdleCandidate {
  key: string;
  lastActivityAt: number;
  boundarySeq: number;
}

interface IdleCompactionState {
  hotSinceSeq?: number | null;
  warmSummaryBeforeSeq?: number | null;
  warmSummaryComputedAt?: string | null;
}

function foregroundMessages(messages: Message[]): Message[] {
  return messages.filter((message) =>
    message.category == null
    && Number.isSafeInteger(message.seq)
    && message.seq! > 0
    && (message.status == null || message.status === "confirmed")
    && message.transcript_status !== "in_progress"
    && !Object.hasOwn(message.metadata ?? {}, "automation_activity"),
  );
}

function findIdleCandidate(foreground: Message[]): IdleCandidate | null {
  const ordered = [...foreground].sort((left, right) => left.seq! - right.seq!);
  const latest = ordered[ordered.length - 1];
  const latestUser = [...ordered].reverse().find((message) => message.role === "user");
  if (!latest || !latestUser?.seq) return null;

  const lastActivityAt = Date.parse(latest.created_at);
  if (!Number.isFinite(lastActivityAt)) return null;

  return {
    key: `${latest.id}:${latest.seq}:${latest.created_at}`,
    lastActivityAt,
    boundarySeq: latestUser.seq,
  };
}

export function useIdleCompactionChoice(
  threadId: string | null,
  messages: Message[],
  enabled: boolean,
  compactionState: IdleCompactionState = {},
) {
  const { hotSinceSeq, warmSummaryBeforeSeq, warmSummaryComputedAt } = compactionState;
  const foreground = useMemo(() => foregroundMessages(messages), [messages]);
  const candidate = useMemo(() => findIdleCandidate(foreground), [foreground]);
  const hotMessageCount = useMemo(
    () => foreground.filter((message) => hotSinceSeq == null || message.seq! >= hotSinceSeq).length,
    [foreground, hotSinceSeq],
  );
  const hasEnoughHotContext = hotMessageCount >= IDLE_COMPACTION_MIN_HOT_MESSAGES;
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [resolvedKeys, setResolvedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const choiceKey = threadId && candidate ? `${threadId}:${candidate.key}` : null;
  const lastActivityAt = candidate?.lastActivityAt;
  const summaryComputedAt = Date.parse(warmSummaryComputedAt ?? "");
  const freshWarmSummary = hotSinceSeq != null
    && warmSummaryBeforeSeq === hotSinceSeq;
  const boundaryCoversCandidate = candidate !== null
    && hotSinceSeq != null
    && hotSinceSeq >= candidate.boundarySeq;
  const alreadyCompacted = Boolean(
    candidate
    && freshWarmSummary
    && (
      boundaryCoversCandidate
      || (Number.isFinite(summaryComputedAt) && summaryComputedAt >= candidate.lastActivityAt)
    ),
  );

  useEffect(() => {
    setReadyKey(null);
    if (!enabled || !choiceKey || lastActivityAt == null || !hasEnoughHotContext) return;

    const delay = Math.max(0, lastActivityAt + IDLE_COMPACTION_DELAY_MS - Date.now());
    const timer = window.setTimeout(() => setReadyKey(choiceKey), delay);
    return () => window.clearTimeout(timer);
  }, [choiceKey, enabled, lastActivityAt, hasEnoughHotContext]);

  const resolve = useCallback(() => {
    if (!choiceKey) return;
    setResolvedKeys((previous) => {
      const next = new Set(previous);
      next.add(choiceKey);
      if (next.size > 32) {
        const oldest = next.values().next().value;
        if (oldest) next.delete(oldest);
      }
      return next;
    });
  }, [choiceKey]);

  return {
    open: Boolean(
      choiceKey
      && readyKey === choiceKey
      && !resolvedKeys.has(choiceKey)
      && !alreadyCompacted
      && hasEnoughHotContext,
    ),
    choiceKey,
    boundarySeq: candidate?.boundarySeq ?? null,
    hotMessageCount,
    resolve,
  };
}
