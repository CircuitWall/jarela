"use client";
import { useEffect, type RefObject } from "react";
import { api } from "@/api/client";
import type { Message } from "@/api/types";
import { appendUnique, applyThreadMeta, isUnconfirmed, type ThreadMetaApplier } from "./chat-helpers";

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
    let cancelled = false;
    let replacementGeneration = 0;
    let appendGeneration = 0;
    let latestReplacement = Promise.resolve();
    function handler(e: Event) {
      const detail = (e as CustomEvent<{
        thread_id: string;
        replace_existing?: boolean;
      }>).detail;
      if (!detail || detail.thread_id !== threadId) return;
      // The local run's own handleDone path already refetches — skip to
      // avoid double-fetching while a turn is mid-stream on this device.
      if (streamingRef.current) return;
      const cur = messagesRef.current ?? [];
      const replaceExisting = detail.replace_existing === true;
      const generation = replaceExisting
        ? ++replacementGeneration
        : ++appendGeneration;
      // Anchor on the last *confirmed* message — an unconfirmed one has no
      // server-assigned `seq` yet. If the only local messages are still
      // pending (e.g. our own send is mid-flight), fall through to the
      // merge branch below rather than the raw-overwrite branch, so this
      // fetch can never drop an in-flight local bubble.
      const confirmed = cur.filter((m) => !isUnconfirmed(m));
      const anchor = !replaceExisting && confirmed.length > 0
        ? confirmed[confirmed.length - 1].seq
        : undefined;
      const fetchPromise = replaceExisting
        ? api.threads.get(threadId, { limit: Math.max(50, cur.length) })
        : anchor !== undefined
        ? api.threads.get(threadId, { after: anchor })
        : api.threads.get(threadId);
      const precedingReplacement = latestReplacement;
      const refresh = fetchPromise.then(async (d) => {
        if (!replaceExisting) await precedingReplacement;
        const currentGeneration = replaceExisting
          ? replacementGeneration
          : appendGeneration;
        if (cancelled || generation !== currentGeneration) return;
        if (replaceExisting) {
          setMessages(() => d.messages);
          setHasMore(d.has_more);
        } else if (anchor !== undefined) {
          if (d.messages.length === 0) return;
          setMessages((prev) => appendUnique(prev, d.messages));
        } else if (cur.length > 0) {
          setMessages((prev) => appendUnique(prev, d.messages));
        } else {
          setMessages(() => d.messages);
          setHasMore(d.has_more);
        }
        applyThreadMeta(applyMeta, d);
      }).catch(console.error);
      if (replaceExisting) latestReplacement = refresh;
    }
    window.addEventListener("jarela:thread-updated", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("jarela:thread-updated", handler);
    };
    // applyMeta and setters are stable refs from useState/object literal in caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);
}
