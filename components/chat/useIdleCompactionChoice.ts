"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Message } from "@/api/types";

export const IDLE_COMPACTION_DELAY_MS = 3 * 60 * 60 * 1000;

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

function findIdleCandidate(messages: Message[]): IdleCandidate | null {
  const foreground = messages.filter((message) =>
    message.category == null
    && Number.isSafeInteger(message.seq)
    && message.seq! > 0
    && (message.status == null || message.status === "confirmed")
    && message.transcript_status !== "in_progress"
    && !Object.hasOwn(message.metadata ?? {}, "automation_activity"),
  ).sort((left, right) => left.seq! - right.seq!);
  const latest = foreground[foreground.length - 1];
  const latestUser = [...foreground].reverse().find((message) => message.role === "user");
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
  const candidate = useMemo(() => findIdleCandidate(messages), [messages]);
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [resolvedKeys, setResolvedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const choiceKey = threadId && candidate ? `${threadId}:${candidate.key}` : null;
  const lastActivityAt = candidate?.lastActivityAt;
  const summaryComputedAt = Date.parse(compactionState.warmSummaryComputedAt ?? "");
  const freshWarmSummary = compactionState.hotSinceSeq != null
    && compactionState.warmSummaryBeforeSeq === compactionState.hotSinceSeq;
  const boundaryCoversCandidate = candidate !== null
    && compactionState.hotSinceSeq != null
    && compactionState.hotSinceSeq >= candidate.boundarySeq;
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
    if (!enabled || !choiceKey || lastActivityAt == null) return;

    const delay = Math.max(0, lastActivityAt + IDLE_COMPACTION_DELAY_MS - Date.now());
    const timer = window.setTimeout(() => setReadyKey(choiceKey), delay);
    return () => window.clearTimeout(timer);
  }, [choiceKey, enabled, lastActivityAt]);

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
    open: Boolean(choiceKey && readyKey === choiceKey && !resolvedKeys.has(choiceKey) && !alreadyCompacted),
    choiceKey,
    boundarySeq: candidate?.boundarySeq ?? null,
    resolve,
  };
}
