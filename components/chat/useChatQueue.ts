"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ContentPart } from "@/api/types";
import { makeQueuedId, type QueuedMessage } from "./chat-helpers";

interface Params {
  threadId: string | null;
  streaming: boolean;
  compacting: boolean;
  launchRun: (text: string, atts: ContentPart[]) => Promise<void>;
}

export interface ChatQueueApi {
  queue: QueuedMessage[];
  queueRef: React.MutableRefObject<QueuedMessage[]>;
  drainQueueRef: React.MutableRefObject<() => void>;
  isReady: () => boolean;
  enqueue: (text: string, atts: ContentPart[]) => void;
  prepend: (text: string, atts: ContentPart[]) => void;
  removeQueued: (id: string) => void;
  retry: (text: string, atts: ContentPart[]) => void;
}

// Owns the FIFO queue of messages typed while a run was already streaming
// or the session wasn't ready. The chat input stays unblocked; we drain
// this queue after each run finishes. Multiple queued user messages get
// merged into one prompt (joined by a blank line) with all attachments
// concatenated, so the agent sees one coherent turn instead of N
// round-trips. The readiness guard makes out-of-band invocations safe
// no-ops.
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
  // `launchRun` is plain function re-created each render; read through ref
  // to keep drain stable.
  const launchRunRef = useRef(launchRun);
  launchRunRef.current = launchRun;

  drainQueueRef.current = () => {
    if (streamingRef.current || compactingRef.current || !threadIdRef.current) return;
    setQueue((q) => {
      if (q.length === 0) return q;
      const text = q.map((m) => m.text).join("\n\n");
      const atts = q.flatMap((m) => m.attachments);
      Promise.resolve().then(() => { void launchRunRef.current(text, atts); });
      return [];
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
    () => !streaming && !compacting && !!threadId && queueRef.current.length === 0,
    [streaming, compacting, threadId],
  );

  const enqueue = useCallback((text: string, atts: ContentPart[]) => {
    setQueue((q) => [...q, { id: makeQueuedId(), text, attachments: atts }]);
  }, []);

  const prepend = useCallback((text: string, atts: ContentPart[]) => {
    setQueue((q) => [{ id: makeQueuedId(), text, attachments: atts }, ...q]);
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
