import { useCallback, useMemo } from "react";
import type { ContentPart, PendingAction } from "@/api/types";
import type { AgentConfig } from "@/api/types";
import { type ChatQueueApi } from "./useChatQueue";
import { buildProposalResponseMessage } from "@/lib/proposals/response-message";
import type { ChatRunOptions } from "./chat-helpers";

interface Params {
  agentId: string | null;
  // Hands a message to the run that is already streaming; resolves false when
  // there was nothing to steer, so the caller falls back to queue-and-abort.
  steerRun: (text: string) => Promise<boolean>;
  attachments: ContentPart[];
  setAttachments: React.Dispatch<React.SetStateAction<ContentPart[]>>;
  queue: ChatQueueApi;
  launchRun: (text: string, atts: ContentPart[], options?: ChatRunOptions) => Promise<void>;
  stopStreaming: () => void;
  streaming: boolean;
  onCompact: () => Promise<void>;
  pendingAutoSpeakRef: React.MutableRefObject<boolean>;
  agentConfig: AgentConfig | null;
}

export function useChatSubmitHandlers({
  agentId,
  steerRun,
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
    if (streaming && atts.length === 0 && await steerRun(msg)) return;
    queue.prepend(msg, atts);
    if (streaming) stopStreaming();
  }, [agentId, attachments, launchRun, onCompact, queue, setAttachments, steerRun, stopStreaming, streaming]);

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

  const handleProposalResolved = useCallback(async (action: PendingAction) => {
    if (!agentId || action.agent_id !== agentId) throw new Error("Proposal belongs to a different agent");
    const message = buildProposalResponseMessage(action);
    const options: ChatRunOptions = { messageMetadata: { hidden_from_chat: true } };
    if (queue.isReady()) { await launchRun(message, [], options); return; }
    queue.enqueue(message, [], options);
  }, [agentId, launchRun, queue]);

  // Shallow projection so the queued-bubble subtree doesn't re-reconcile
  // on every streaming delta.
  const queuedMessages = useMemo(
    () => queue.queue.map((q) => ({
      id: q.id,
      text: q.options?.messageMetadata?.hidden_from_chat ? "Continue after your response" : q.text,
      attachmentCount: q.attachments.length,
    })),
    [queue.queue],
  );

  return {
    handleSubmit,
    handleQueue,
    handleVoiceTranscript,
    handleRetryMessage,
    handleProposalResolved,
    queuedMessages,
  };
}
