"use client";
import type { ContentPart, Message } from "@/api/types";

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: ContentPart[];
}

export interface SystemNotice {
  id: string;
  text: string;
}

export interface ThreadMetaApplier {
  setHotSince: (v: string | null) => void;
  setWarmSummary: (v: string | null) => void;
  setWarmSummaryBefore: (v: string | null) => void;
  setWarmSummaryComputedAt: (v: string | null) => void;
  setContextWindowTokens: (v: number | null) => void;
}

export interface ThreadGetPayload {
  hot_since?: string | null;
  warm_summary?: string | null;
  warm_summary_before?: string | null;
  warm_summary_computed_at?: string | null;
  context_window_tokens?: number | null;
}

// Append-with-dedupe. After a run finishes, two independent code paths can
// both fetch the freshly-persisted user+assistant rows and append them:
//   1) handleDone (driven by the SSE `done` event for the local run), and
//   2) the `jarela:thread-updated` window listener (driven by the
//      cross-device events bus notification for the same run).
// Dedupe by id at the append site so either ordering converges to the
// same list.
export function appendUnique(prev: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return prev;
  const seen = new Set(prev.map((m) => m.id));
  const fresh = incoming.filter((m) => !seen.has(m.id));
  return fresh.length === 0 ? prev : prev.concat(fresh);
}

export function applyThreadMeta(meta: ThreadMetaApplier, payload: ThreadGetPayload): void {
  meta.setHotSince(payload.hot_since ?? null);
  meta.setWarmSummary(payload.warm_summary ?? null);
  meta.setWarmSummaryBefore(payload.warm_summary_before ?? null);
  meta.setWarmSummaryComputedAt(payload.warm_summary_computed_at ?? null);
  meta.setContextWindowTokens(payload.context_window_tokens ?? null);
}

export function makeQueuedId(prefix = "q"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
