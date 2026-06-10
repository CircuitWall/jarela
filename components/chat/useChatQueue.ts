"use client";
import { useCallback, useRef, useState } from "react";
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

  const drainQueueRef = useRef<() => void>(() => {});
  // `launchRun` is plain function re-created each render; read through ref
  // to keep drain stable.
  const launchRunRef = useRef(launchRun);
  launchRunRef.current = launchRun;

  drainQueueRef.current = () => {
    if (streaming || compacting || !threadId) return;
    setQueue((q) => {
      if (q.length === 0) return q;
      const text = q.map((m) => m.text).join("\n\n");
      const atts = q.flatMap((m) => m.attachments);
      Promise.resolve().then(() => { void launchRunRef.current(text, atts); });
      return [];
    });
  };

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
