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
  setWarmSummaryPending?: (v: boolean) => void;
  setCompactionPending?: (v: boolean) => void;
}

export interface ThreadGetPayload {
  hot_since?: string | null;
  warm_summary?: string | null;
  warm_summary_before?: string | null;
  warm_summary_computed_at?: string | null;
  warm_summary_source_messages?: number | null;
  warm_summary_source_chars?: number | null;
  pending_hot_since?: string | null;
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
//
// The final step re-sorts by `created_at` ASC. This matters whenever a user
// bubble is appended optimistically while a reply is still in flight: the
// client stamps it before the server has finished persisting the assistant
// message. Both remaining paths do this — Stop (or an attachment submit)
// followed by a queue drain, and steering, which the server persists mid-run.
// Without the sort, the earlier assistant reply (server timestamp T2) lands
// AFTER the user bubble (client timestamp T3 ≈ later) even though the true
// order is [user, reply, user].
// Since a single-machine install has ≤1ms clock skew, the ISO string
// timestamps sort correctly and Array.sort's stability preserves the
// relative order of same-timestamp confirmations.
// A bubble the client created optimistically and the server has not yet
// echoed back. All of these reconcile in place; only the label differs.
export function isUnconfirmed(m: Message): boolean {
  return m.status === 'pending' || m.status === 'sent' || m.status === 'steering';
}

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

    // Rule 2: confirm a matching optimistic user bubble in place. Every
    // unconfirmed lifecycle state is a candidate.
    if (server.role === 'user') {
      const optIdx = result.findIndex(
        (m) => isUnconfirmed(m) && m.role === 'user' && m.content === server.content
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

  result.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  return result;
}

export function applyThreadMeta(meta: ThreadMetaApplier, payload: ThreadGetPayload): void {
  const hotSince = payload.hot_since ?? null;
  const summaryBefore = payload.warm_summary_before ?? null;
  meta.setHotSince(hotSince);
  meta.setWarmSummary(payload.warm_summary ?? null);
  meta.setWarmSummaryBefore(summaryBefore);
  meta.setWarmSummaryComputedAt(payload.warm_summary_computed_at ?? null);
  meta.setWarmSummarySourceMessages(payload.warm_summary_source_messages ?? null);
  meta.setWarmSummarySourceChars(payload.warm_summary_source_chars ?? null);
  meta.setContextWindowTokens(payload.context_window_tokens ?? null);
  meta.setWarmSummaryPending?.(!!hotSince && summaryBefore !== hotSince);
  meta.setCompactionPending?.(!!payload.pending_hot_since);
}

export function makeQueuedId(prefix = "q"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
