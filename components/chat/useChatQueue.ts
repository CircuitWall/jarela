"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ContentPart } from "@/api/types";
import { makeQueuedId, type ChatRunOptions, type QueuedMessage } from "./chat-helpers";

interface Params {
  threadId: string | null;
  streaming: boolean;
  compacting: boolean;
  launchRun: (text: string, atts: ContentPart[], options?: ChatRunOptions) => Promise<void>;
}

export interface ChatQueueApi {
  queue: QueuedMessage[];
  queueRef: React.MutableRefObject<QueuedMessage[]>;
  drainQueueRef: React.MutableRefObject<() => void>;
  isReady: () => boolean;
  enqueue: (text: string, atts: ContentPart[], options?: ChatRunOptions) => void;
  prepend: (text: string, atts: ContentPart[], options?: ChatRunOptions) => void;
  removeQueued: (id: string) => void;
  retry: (text: string, atts: ContentPart[]) => void;
}

// Owns the FIFO queue of messages typed while a run was already streaming
// or the session wasn't ready. The chat input stays unblocked; we drain
// this queue after each run finishes. Consecutive ordinary user messages
// merge into one prompt with attachments concatenated; turns with explicit
// options stay separate to preserve their visibility. The readiness guard
// makes out-of-band invocations safe no-ops.
export function useChatQueue({ threadId, streaming, compacting, launchRun }: Params): ChatQueueApi {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const queueRef = useRef<QueuedMessage[]>([]);
  queueRef.current = queue;

  // Mirror readiness state into refs so the drain closure reads the live
  // values instead of whatever was captured during the render that built
  // it. handleCompact's finally calls drainQueueRef.current() synchronously
  // right after setCompacting(false) — at that point React hasn't committed
  // the new render, so a closure-captured `compacting` would still be true
  // and the drain would bail out, leaving queued messages stranded.
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  const compactingRef = useRef(compacting);
  compactingRef.current = compacting;
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const drainQueueRef = useRef<() => void>(() => {});
  const drainingRef = useRef(false);
  // `launchRun` is plain function re-created each render; read through ref
  // to keep drain stable.
  const launchRunRef = useRef(launchRun);
  launchRunRef.current = launchRun;

  drainQueueRef.current = () => {
    if (drainingRef.current || streamingRef.current || compactingRef.current || !threadIdRef.current) return;
    const queued = queueRef.current;
    if (queued.length === 0) return;
    // Keep internal turns separate so their visibility cannot hide user text.
    const boundary = queued[0].options ? 1 : queued.findIndex((message) => message.options);
    const batch = queued.slice(0, boundary < 0 ? queued.length : boundary);
    const remaining = queued.slice(batch.length);
    queueRef.current = remaining;
    setQueue(remaining);
    drainingRef.current = true;
    const text = batch.map((message) => message.text).join("\n\n");
    const atts = batch.flatMap((message) => message.attachments);
    const run = batch[0].options
      ? launchRunRef.current(text, atts, batch[0].options)
      : launchRunRef.current(text, atts);
    void run.catch((error) => console.error("Queued chat submission failed", error)).finally(() => {
      drainingRef.current = false;
      drainQueueRef.current();
    });
  };

  // Belt-and-braces: also drain whenever readiness flips back to ready.
  // Covers paths that change `streaming` / `compacting` without calling
  // drainQueueRef.current() in a finally (e.g. compact error before the
  // finally lands, or external state updates from useThreadCrossDeviceSync).
  useEffect(() => {
    if (streaming || compacting || !threadId) return;
    if (queue.length === 0) return;
    drainQueueRef.current();
  }, [streaming, compacting, threadId, queue.length]);

  const isReady = useCallback(
    () => !drainingRef.current && !streaming && !compacting && !!threadId && queueRef.current.length === 0,
    [streaming, compacting, threadId],
  );

  const enqueue = useCallback((text: string, atts: ContentPart[], options?: ChatRunOptions) => {
    setQueue((q) => [...q, { id: makeQueuedId(), text, attachments: atts, ...(options ? { options } : {}) }]);
  }, []);

  const prepend = useCallback((text: string, atts: ContentPart[], options?: ChatRunOptions) => {
    setQueue((q) => [{ id: makeQueuedId(), text, attachments: atts, ...(options ? { options } : {}) }, ...q]);
  }, []);

  const removeQueued = useCallback((id: string) => {
    setQueue((q) => q.filter((m) => m.id !== id));
  }, []);

  const retry = useCallback((text: string, atts: ContentPart[]) => {
    if (!threadId) return;
    if (isReady()) {
      void launchRunRef.current(text, atts);
      return;
    }
    setQueue((q) => [...q, { id: makeQueuedId(), text, attachments: atts }]);
  }, [threadId, isReady]);

  return { queue, queueRef, drainQueueRef, isReady, enqueue, prepend, removeQueued, retry };
}
