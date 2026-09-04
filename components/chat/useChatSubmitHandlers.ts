import { useCallback, useMemo } from "react";
import type { ContentPart } from "@/api/types";
import type { AgentConfig } from "@/api/types";
import { api } from "@/api/client";
import { type ChatQueueApi } from "./useChatQueue";

interface Params {
  agentId: string | null;
  threadId: string | null;
  attachments: ContentPart[];
  setAttachments: React.Dispatch<React.SetStateAction<ContentPart[]>>;
  queue: ChatQueueApi;
  launchRun: (text: string, atts: ContentPart[]) => Promise<void>;
  stopStreaming: () => void;
  streaming: boolean;
  onCompact: () => Promise<void>;
  pendingAutoSpeakRef: React.MutableRefObject<boolean>;
  agentConfig: AgentConfig | null;
}

export function useChatSubmitHandlers({
  agentId,
  threadId,
  attachments,
  setAttachments,
  queue,
  launchRun,
  stopStreaming,
  streaming,
  onCompact,
  pendingAutoSpeakRef,
  agentConfig,
}: Params) {
  // Default Send / Enter. Send-when-idle, STEER-when-streaming.
  // Steering hands the message to the running agent, which picks it up before
  // its next model call (ADR-0080) — the run is NOT aborted, so its in-flight
  // tool work survives. Only the Stop button interrupts. Attachments can't ride
  // the steering channel, so those still queue and abort.
  const handleSubmit = useCallback(async (rawInput: string) => {
    let msg = rawInput.trim();
    if (!msg || !agentId) return;
    if (msg.toLowerCase() === "/new") { await onCompact(); return; }
    // /btw is intent flavor — strip the prefix so the agent never sees it.
    if (msg.toLowerCase().startsWith("/btw ")) {
      msg = msg.slice(5).trim();
      if (!msg) return;
    }
    const atts = attachments;
    setAttachments([]);
    if (queue.isReady()) { await launchRun(msg, atts); return; }
    if (streaming && threadId && atts.length === 0) {
      const { steered } = await api.threads.steerRun(threadId, msg);
      if (steered) return;
    }
    queue.prepend(msg, atts);
    if (streaming) stopStreaming();
  }, [agentId, attachments, launchRun, onCompact, queue, setAttachments, stopStreaming, streaming, threadId]);

  // Ctrl/Cmd+Enter — explicit "queue this turn" path. Always appends; never
  // aborts. When idle and the queue is empty we just send normally.
  const handleQueue = useCallback(async (rawInput: string) => {
    const msg = rawInput.trim();
    if (!msg || !agentId) return;
    if (msg.toLowerCase() === "/new" || msg.toLowerCase().startsWith("/btw ")) {
      await handleSubmit(rawInput);
      return;
    }
    const atts = attachments;
    setAttachments([]);
    if (queue.isReady()) { await launchRun(msg, atts); return; }
    queue.enqueue(msg, atts);
  }, [agentId, attachments, handleSubmit, launchRun, queue, setAttachments]);

  const handleVoiceTranscript = useCallback((text: string) => {
    const msg = text.trim();
    if (!msg || !agentId) return;
    if (agentConfig?.voice_auto_speak !== false) pendingAutoSpeakRef.current = true;
    if (queue.isReady()) { void launchRun(msg, []); return; }
    queue.enqueue(msg, []);
  }, [agentConfig?.voice_auto_speak, agentId, launchRun, pendingAutoSpeakRef, queue]);

  const handleRetryMessage = useCallback((text: string, atts: ContentPart[]) => {
    const msg = text.trim();
    if (!msg || !agentId) return;
    queue.retry(msg, atts);
  }, [agentId, queue]);

  // Shallow projection so the queued-bubble subtree doesn't re-reconcile
  // on every streaming delta.
  const queuedMessages = useMemo(
    () => queue.queue.map((q) => ({ id: q.id, text: q.text, attachmentCount: q.attachments.length })),
    [queue.queue],
  );

  return {
    handleSubmit,
    handleQueue,
    handleVoiceTranscript,
    handleRetryMessage,
    queuedMessages,
  };
}
