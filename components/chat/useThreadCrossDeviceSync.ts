"use client";
import { useEffect, type RefObject } from "react";
import { api } from "@/api/client";
import type { Message } from "@/api/types";
import { appendUnique, applyThreadMeta, type ThreadMetaApplier } from "./chat-helpers";

interface Params {
  threadId: string | null;
  streamingRef: RefObject<boolean>;
  messagesRef: RefObject<Message[]>;
  setMessages: (updater: (prev: Message[]) => Message[]) => void;
  setHasMore: (v: boolean) => void;
  applyMeta: ThreadMetaApplier;
}

// Cross-device thread sync. When ANOTHER client (iOS PWA, bridge, scheduled
// task) appends to this thread, the server publishes a notification on the
// events bus. `useEventNotifications` dispatches a `jarela:thread-updated`
// window event for every such ping. If it matches the thread we're viewing
// and we're not currently the source of the run (no local stream in flight),
// forward-fetch new messages so the chat list updates without a manual
// page refresh.
export function useThreadCrossDeviceSync({
  threadId,
  streamingRef,
  messagesRef,
  setMessages,
  setHasMore,
  applyMeta,
}: Params) {
  useEffect(() => {
    if (!threadId) return;
    function handler(e: Event) {
      const detail = (e as CustomEvent<{ thread_id: string }>).detail;
      if (!detail || detail.thread_id !== threadId) return;
      // The local run's own handleDone path already refetches — skip to
      // avoid double-fetching while a turn is mid-stream on this device.
      if (streamingRef.current) return;
      const cur = messagesRef.current ?? [];
      const anchor = cur.length > 0 ? cur[cur.length - 1].created_at : undefined;
      const fetchPromise = anchor
        ? api.threads.get(threadId, { after: anchor })
        : api.threads.get(threadId);
      fetchPromise.then((d) => {
        if (anchor) {
          if (d.messages.length === 0) return;
          setMessages((prev) => appendUnique(prev, d.messages));
        } else {
          setMessages(() => d.messages);
          setHasMore(d.has_more);
        }
        applyThreadMeta(applyMeta, d);
      }).catch(console.error);
    }
    window.addEventListener("jarela:thread-updated", handler);
    return () => window.removeEventListener("jarela:thread-updated", handler);
    // applyMeta and setters are stable refs from useState/object literal in caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);
}
