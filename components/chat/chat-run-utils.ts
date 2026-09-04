import { api } from "@/api/client";
import type { Message } from "@/api/types";
import { appendUnique, applyThreadMeta, type ThreadMetaApplier } from "./chat-helpers";

export interface FinalizeParams {
  threadId: string;
  messagesRef: React.MutableRefObject<Message[]>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setHasMore: (v: boolean) => void;
  applyMeta: ThreadMetaApplier;
  clearStreaming: () => void;
  pendingAutoSpeakRef: React.MutableRefObject<boolean>;
}

// Forward-fetch only the messages persisted after our newest known one.
// Typically two rows (user + assistant) instead of the full 50-row page,
// so this is O(turn) instead of O(thread). Falls back to full reload if
// no anchor (fresh thread, race).
//
// Anchor on the last *persisted* row, never an `opt-*` optimistic — the
// optimistic's created_at is from the client clock and could skip the
// just-persisted user row if it skews ahead of the server.
export async function finalizeRunFromServer(p: FinalizeParams): Promise<void> {
  // Anchor on the last confirmed (non-opt-*) message so we only fetch the
  // delta. Falls back to a full reload when there are no confirmed messages yet.
  const confirmed = p.messagesRef.current.filter((m) => m.status !== "pending");
  const anchor = confirmed.length > 0 ? confirmed[confirmed.length - 1].created_at : undefined;
  const d = anchor
    ? await api.threads.get(p.threadId, { after: anchor })
    : await api.threads.get(p.threadId);
  // appendUnique reconciles: pending bubbles are promoted to confirmed in
  // place (no deletion). Any new pending bubble added by the queue drain
  // while the fetch was in flight is untouched — it has different content.
  p.setMessages((prev) => appendUnique(prev, d.messages));
  if (!anchor) p.setHasMore(d.has_more);
  applyThreadMeta(p.applyMeta, d);
  p.clearStreaming();
  if (p.pendingAutoSpeakRef.current) {
    p.pendingAutoSpeakRef.current = false;
    const latest = [...d.messages].reverse().find((m) => m.role === "assistant" && m.id);
    if (latest?.id && typeof window !== "undefined") {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("jarela:speak-message", { detail: { messageId: latest.id } }));
      });
    }
  }
}

// The placeholder answers "what happens if I type right now?" — it is an
// affordance label, not a status display. Pure load states report in the
// header activity instead, since they don't change what a keystroke does.
export function composerPlaceholder(s: {
  compacting: boolean;
  sessionLoading: boolean;
  streaming?: boolean;
}): string | undefined {
  if (s.compacting) return "Compacting session… your messages will queue";
  if (s.sessionLoading) return "Loading session… your messages will queue";
  if (s.streaming) return "Steer the agent…";
  return undefined;
}
