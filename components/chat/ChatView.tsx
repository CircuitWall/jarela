"use client";
import { useCallback, useRef, useState } from "react";
import { api } from "@/api/client";
import type { ContentPart } from "@/api/types";
import { useSSE } from "@/hooks/useSSE";
import { useAppContext } from "@/contexts/AppContext";
import { useTrackLoading } from "@/lib/ui/loading";
import { ApprovalsBanner } from "@/components/proposals/ApprovalsBanner";
import { AuthErrorBanner } from "./AuthErrorBanner";
import { InputBar } from "./InputBar";
import { MessageList } from "./MessageList";
import { makeQueuedId } from "./chat-helpers";
import { useChatErrorReporting } from "./useChatErrorReporting";
import { useChatQueue, type ChatQueueApi } from "./useChatQueue";
import { useThreadCrossDeviceSync } from "./useThreadCrossDeviceSync";
import { useThreadData } from "./useThreadData";
import { useUserProfileAndAgent } from "./useUserProfileAndAgent";
import { composerPlaceholder, finalizeRunFromServer } from "./chat-run-utils";
import { useChatSubmitHandlers } from "./useChatSubmitHandlers";

interface Props {
  threadId: string | null;
  agentId: string | null;
  sessionLoading?: boolean;
  sessionError?: string | null;
  onMessageSent: () => void;
}

export function ChatView({ threadId, agentId, sessionLoading, sessionError, onMessageSent }: Props) {
  const { state } = useAppContext();
  const [attachments, setAttachments] = useState<ContentPart[]>([]);
  const [compacting, setCompacting] = useState(false);
  const { userProfile, profileLoading, agentConfig, agentConfigLoading } =
    useUserProfileAndAgent(agentId);

  // attach() comes from useSSE which we call later. Bridge via a ref so
  // useThreadData's effect can call it after both hooks render.
  const attachRef = useRef<((id: string) => Promise<unknown>) | null>(null);
  const stableAttach = useCallback(
    (id: string) => attachRef.current?.(id) ?? Promise.resolve(undefined),
    [],
  );
  const thread = useThreadData({ threadId, attach: stableAttach });

  // When the next user turn came from a voice transcription, arm this flag
  // so handleDone can fire a `jarela:speak-message` event at the new
  // assistant message id and the bubble auto-plays the TTS reply once.
  const pendingAutoSpeakRef = useRef(false);
  // Need clearStreamingContent before useSSE returns it. Use a ref so
  // handleDone isn't dependent on the hook's return value.
  const clearStreamingRef = useRef<() => void>(() => {});
  const drainQueueRef = useRef<() => void>(() => {});
  const queueApiRef = useRef<ChatQueueApi | null>(null);

  const handleDone = useCallback(() => {
    if (!threadId) return;
    finalizeRunFromServer({
      threadId,
      messagesRef: thread.messagesRef,
      setMessages: thread.setMessages,
      setHasMore: thread.setHasMore,
      applyMeta: thread.metaApplier,
      clearStreaming: () => clearStreamingRef.current(),
      pendingAutoSpeakRef,
    }).finally(() => drainQueueRef.current());
    onMessageSent();
    // hook setters/refs are stable; intentionally exclude `thread`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, onMessageSent]);

  const sse = useSSE(handleDone);
  attachRef.current = sse.attach;
  clearStreamingRef.current = sse.clearStreamingContent;

  useChatErrorReporting({ sessionError, streamError: sse.error, authError: sse.authError, agentId, threadId });

  const streamingRef = useRef(false);
  streamingRef.current = sse.streaming;

  useThreadCrossDeviceSync({
    threadId,
    streamingRef,
    messagesRef: thread.messagesRef,
    setMessages: thread.setMessages,
    setHasMore: thread.setHasMore,
    applyMeta: thread.metaApplier,
  });

  useTrackLoading(!!sessionLoading);
  useTrackLoading(sse.streaming);
  useTrackLoading(compacting);
  useTrackLoading(thread.loadingMore);
  useTrackLoading(thread.messagesLoading);
  useTrackLoading(agentConfigLoading);

  // Actually fire a run for one message. Used by direct submit and by the
  // queue's drain after a previous run finishes.
  const launchRun = useCallback(async (text: string, atts: ContentPart[]) => {
    if (!threadId) return;
    const optId = `opt-${makeQueuedId("")}`;
    const optimisticContent = atts.length
      ? JSON.stringify([{ type: "text" as const, text }, ...atts])
      : text;
    thread.setMessages((p) => [
      ...p,
      { id: optId, role: "user", content: optimisticContent, created_at: new Date().toISOString(), status: 'pending' },
    ]);
    const { accepted } = await sse.start(
      threadId,
      text,
      { filters: { include_tools: true, include_thinking: true }, ui_experience_mode: state.experienceMode },
      atts.length ? atts : undefined,
      thread.hotSince ?? undefined,
    );
    if (!accepted) {
      // Server rejected because another run was in flight (second tab,
      // other device). attach() return value feeds our deltas. Roll back
      // the optimistic user bubble and re-queue this message so the
      // drain after the in-flight run's `done` resubmits cleanly.
      thread.setMessages((p) => p.filter((m) => m.id !== optId));
      queueApiRef.current?.prepend(text, atts);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, sse, state.experienceMode]);

  const queue = useChatQueue({ threadId, streaming: sse.streaming, compacting, launchRun });
  queueApiRef.current = queue;
  drainQueueRef.current = queue.drainQueueRef.current;

  async function handleCompact() {
    if (!agentId) return;
    setCompacting(true);
    try {
      const result = await api.agents.compact(agentId);
      if (result.compacted) {
        // Server moved the hot/warm pin to just after the last existing
        // message and persisted the warm summary. Mirror that in-place so
        // the warm card shows the fresh summary without wiping the visible
        // transcript. The user can still scroll up to read prior turns;
        // older history past JARELA_MAX_THREAD_MESSAGES has been pruned
        // server-side but its content lives on inside the warm summary.
        thread.metaApplier.setHotSince(result.hot_since ?? null);
        thread.metaApplier.setWarmSummary(result.warm_summary ?? null);
        thread.metaApplier.setWarmSummaryBefore(result.warm_summary_before ?? null);
        thread.metaApplier.setWarmSummaryComputedAt(result.warm_summary_computed_at ?? null);
        thread.metaApplier.setWarmSummarySourceMessages(result.warm_summary_source_messages ?? null);
        thread.metaApplier.setWarmSummarySourceChars(result.warm_summary_source_chars ?? null);
      } else {
        thread.addNotice("Nothing to compact yet — send some messages first.");
      }
    } catch (err) {
      thread.addNotice(`Compaction failed: ${String(err)}`);
    } finally {
      setCompacting(false);
      queue.drainQueueRef.current();
    }
  }

  const {
    handleSubmit,
    handleQueue,
    handleVoiceTranscript,
    handleRetryMessage,
    queuedMessages,
  } = useChatSubmitHandlers({
    agentId,
    attachments,
    setAttachments,
    queue,
    launchRun,
    stopStreaming: sse.stop,
    streaming: sse.streaming,
    onCompact: handleCompact,
    pendingAutoSpeakRef,
    agentConfig,
  });

  return (
    <div className="flex flex-col h-full">
      <MessageList
        threadId={threadId}
        messages={thread.messages}
        notices={thread.notices}
        agentConfig={agentConfig}
        userProfile={userProfile}
        // streamingContent stays visible past `streaming=false` so the bubble
        // doesn't disappear before the refetch arrives. Cleared atomically
        // via clearStreamingRef once the persisted message lands.
        streamingContent={sse.streamingContent || undefined}
        // Keep the live thinking line visible past `streaming=false` so a
        // user who's still reading isn't yanked out mid-sentence.
        thinkingContent={sse.thinkingContent || undefined}
        toolEvents={sse.streaming ? sse.toolEvents : undefined}
        hasMore={thread.hasMore}
        loadingMore={thread.loadingMore}
        onLoadMore={thread.loadOlder}
        queuedMessages={queuedMessages}
        onRemoveQueued={queue.removeQueued}
        hotSince={thread.hotSince}
        warmSummary={thread.warmSummary}
        warmSummaryBefore={thread.warmSummaryBefore}
        warmSummaryComputedAt={thread.warmSummaryComputedAt}
        warmSummarySourceMessages={thread.warmSummarySourceMessages}
        warmSummarySourceChars={thread.warmSummarySourceChars}
        warmSummaryPending={thread.warmSummaryPending}
        onSetContextPin={thread.setContextPin}
        streaming={sse.streaming}
        contextWindowTokens={thread.contextWindowTokens}
        onRetryMessage={handleRetryMessage}
      />

      <ApprovalsBanner agentId={agentId} />
      <AuthErrorBanner authError={sse.authError} onDismiss={sse.dismissAuthError} />

      <InputBar
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        onSubmit={handleSubmit}
        onQueue={handleQueue}
        onStop={sse.stop}
        streaming={sse.streaming}
        voiceEnabled={!!agentConfig?.voice_enabled}
        agentId={agentId}
        onVoiceTranscript={handleVoiceTranscript}
        disabled={!agentId}
        placeholder={composerPlaceholder({
          compacting,
          sessionLoading: !!sessionLoading,
          messagesLoading: thread.messagesLoading,
          agentConfigLoading,
          profileLoading,
        })}
      />
    </div>
  );
}
