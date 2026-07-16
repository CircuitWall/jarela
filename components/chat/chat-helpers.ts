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
  setWarmSummarySourceMessages: (v: number | null) => void;
  setWarmSummarySourceChars: (v: number | null) => void;
  setContextWindowTokens: (v: number | null) => void;
}

export interface ThreadGetPayload {
  hot_since?: string | null;
  warm_summary?: string | null;
  warm_summary_before?: string | null;
  warm_summary_computed_at?: string | null;
  warm_summary_source_messages?: number | null;
  warm_summary_source_chars?: number | null;
  context_window_tokens?: number | null;
}

// Append-with-reconcile. Merges server-persisted rows into the local list
// with three rules, applied in order for each incoming message:
//
//   1. Already present by server id → update in place (handles the
//      handleDone / cross-device double-fetch race; both orderings converge).
//
//   2. User message + a pending (opt-*) placeholder with matching content
//      exists → confirm that placeholder in place. This is the key
//      structural invariant: optimistic user bubbles are NEVER deleted and
//      re-added; they are promoted from pending → confirmed when the server
//      row arrives, so the bubble never disappears from the chat.
//
//   3. Genuinely new → append.
//
// All incoming rows are stamped status='confirmed'. The local pending bubbles
// carry status='pending' until promoted here.
export function appendUnique(prev: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return prev;
  const result = [...prev];
  const idxById = new Map(result.map((m, i) => [m.id, i]));

  for (const server of incoming) {
    const confirmed: Message = { ...server, status: 'confirmed' };

    // Rule 1: dedup by server-assigned id
    const existing = idxById.get(server.id);
    if (existing !== undefined) {
      result[existing] = confirmed;
      continue;
    }

    // Rule 2: confirm a matching pending user bubble in place
    if (server.role === 'user') {
      const optIdx = result.findIndex(
        (m) => m.status === 'pending' && m.role === 'user' && m.content === server.content
      );
      if (optIdx >= 0) {
        idxById.delete(result[optIdx].id);
        result[optIdx] = confirmed;
        idxById.set(server.id, optIdx);
        continue;
      }
    }

    // Rule 3: new message
    idxById.set(server.id, result.length);
    result.push(confirmed);
  }

  return result;
}

export function applyThreadMeta(meta: ThreadMetaApplier, payload: ThreadGetPayload): void {
  meta.setHotSince(payload.hot_since ?? null);
  meta.setWarmSummary(payload.warm_summary ?? null);
  meta.setWarmSummaryBefore(payload.warm_summary_before ?? null);
  meta.setWarmSummaryComputedAt(payload.warm_summary_computed_at ?? null);
  meta.setWarmSummarySourceMessages(payload.warm_summary_source_messages ?? null);
  meta.setWarmSummarySourceChars(payload.warm_summary_source_chars ?? null);
  meta.setContextWindowTokens(payload.context_window_tokens ?? null);
}

export function makeQueuedId(prefix = "q"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
