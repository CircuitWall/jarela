"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { ContentPart } from "@/api/types";
import { useSSE } from "@/hooks/useSSE";
import { useMessageFilters } from "@/hooks/useMessageFilters";
import { clearFirstRunChatKickoff, useAppContext } from "@/contexts/AppContext";
import { useTrackLoading, useActivityWhile } from "@/lib/ui/loading";
import { pushToast } from "@/lib/ui/toasts";
import { pushErrorToast } from "@/lib/ui/error-report";
import { ApprovalsBanner } from "@/components/proposals/ApprovalsBanner";
import { AuthErrorBanner } from "./AuthErrorBanner";
import { InputBar } from "./InputBar";
import { MessageList } from "./MessageList";
import { applyThreadMeta, compactionOutcomeToast, makeQueuedId, parseWarmSummaryTopics, type CompactionOutcome } from "./chat-helpers";
import { useChatErrorReporting } from "./useChatErrorReporting";
import { useChatQueue, type ChatQueueApi } from "./useChatQueue";
import { useThreadCrossDeviceSync } from "./useThreadCrossDeviceSync";
import { useThreadData } from "./useThreadData";
import { useThreadMetadataPolling } from "./useThreadMetadataPolling";
import { useThreadActivity } from "./useThreadActivity";
import { useUserProfileAndAgent } from "./useUserProfileAndAgent";
import { composerPlaceholder, finalizeRunFromServer } from "./chat-run-utils";
import { useChatSubmitHandlers } from "./useChatSubmitHandlers";
import { useFirstRunChatKickoff } from "./useFirstRunChatKickoff";
import { isMarkedFirstRunThread, useIsFirstRunThread } from "@/lib/ui/first-run-thread";

interface Props {
  threadId: string | null;
  agentId: string | null;
  sessionLoading?: boolean;
  sessionError?: string | null;
  onMessageSent: () => void;
}

export function ChatView({ threadId, agentId, sessionLoading, sessionError, onMessageSent }: Props) {
  const { state, dispatch } = useAppContext();
  const hideInternalOperations = useIsFirstRunThread(threadId);
  const [attachments, setAttachments] = useState<ContentPart[]>([]);
  const controlsRef = useRef<HTMLDivElement>(null);
  const [controlsHeight, setControlsHeight] = useState(0);
  useLayoutEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const measure = () => setControlsHeight(controls.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(controls);
    return () => observer.disconnect();
  }, []);
  const [compacting, setCompacting] = useState(false);
  const { userProfile, profileLoading, agentConfig, agentConfigLoading } =
    useUserProfileAndAgent(agentId);
  // Lifted here (not called again inside MessageList) so the channel chips'
  // toggle state and the channel set the next run submits with can never
  // drift out of sync — two separate hook instances would each hold their
  // own copy, synced only eventually via refetch. See ADR-0044.
  const messageFilters = useMessageFilters(agentConfig?.id ?? null);

  // attach() comes from useSSE which we call later. Bridge via a ref so
  // useThreadData's effect can call it after both hooks render.
  const attachRef = useRef<((id: string, quietActivity?: boolean) => Promise<unknown>) | null>(null);
  const stableAttach = useCallback(
    (id: string) => attachRef.current?.(id, isMarkedFirstRunThread(id)) ?? Promise.resolve(undefined),
    [],
  );
  const thread = useThreadData({ threadId, attach: stableAttach });
  const currentThreadMessages = thread.messagesThreadId === threadId ? thread.messages : [];

  // When the next user turn came from a voice transcription, arm this flag
  // so handleDone can fire a `jarela:speak-message` event at the new
  // assistant message id and the bubble auto-plays the TTS reply once.
  const pendingAutoSpeakRef = useRef(false);
  // Need clearStreamingContent/clearToolEvents before useSSE returns them.
  // Use refs so handleDone isn't dependent on the hook's return value.
  const clearStreamingRef = useRef<() => void>(() => {});
  const clearToolEventsRef = useRef<() => void>(() => {});
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
      clearStreaming: () => {
        // Clears streamingContent and steeredSegments together — see
        // useSSE's clearStreamingContent.
        clearStreamingRef.current();
        clearToolEventsRef.current();
      },
      pendingAutoSpeakRef,
    }).finally(() => drainQueueRef.current());
    onMessageSent();
    // hook setters/refs are stable; intentionally exclude `thread`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, onMessageSent]);

  const sse = useSSE(handleDone);
  attachRef.current = sse.attach;
  clearStreamingRef.current = sse.clearStreamingContent;
  clearToolEventsRef.current = sse.clearToolEvents;
  // `compacting` lives in this component, which remounts per agent; the
  // server flag keeps a /compact started before an agent switch visible.
  const sessionCompacting = compacting || thread.manualCompactionPending;

  const activity = useThreadActivity({
    threadId,
    attach: stableAttach,
    isLive: sse.isLive,
    lastSettledAt: sse.lastSettledAt,
    metaApplier: thread.metaApplier,
  });
  // Run phases come through the attached stream; background compaction
  // outside a run has no stream, so label it from the polled activity.
  const backgroundCompaction = !sse.streaming && !sessionCompacting ? activity?.compaction?.kind ?? null : null;

  useChatErrorReporting({ sessionError, streamError: sse.error, authError: sse.authError, agentId, threadId });

  const streamingRef = useRef(false);
  streamingRef.current = sse.streaming;
  const currentThreadIdRef = useRef(threadId);
  currentThreadIdRef.current = threadId;

  useThreadMetadataPolling(
    threadId,
    sse.streaming || thread.warmSummaryPending || thread.compactionPending || thread.manualCompactionPending,
    thread.metaApplier,
  );

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
  useTrackLoading(sessionCompacting);
  useTrackLoading(thread.loadingMore);
  useTrackLoading(thread.messagesLoading);
  useTrackLoading(agentConfigLoading);

  useActivityWhile(sessionCompacting, "Compacting session…");
  useActivityWhile(backgroundCompaction === "auto", "Compacting earlier messages…");
  useActivityWhile(backgroundCompaction === "refresh", "Updating summary…");
  useActivityWhile(thread.messagesLoading, "Loading chat history…");
  useActivityWhile(agentConfigLoading, "Loading agent…");
  useActivityWhile(profileLoading, "Loading profile…");

  // Actually fire a run for one message. Used by direct submit and by the
  // queue's drain after a previous run finishes.
  const launchRun = useCallback(async (
    text: string,
    atts: ContentPart[],
    options?: { quiet?: boolean; messageMetadata?: Record<string, unknown> },
  ) => {
    if (!threadId) return;
    const optId = `opt-${makeQueuedId("")}`;
    const optimisticContent = atts.length
      ? JSON.stringify([{ type: "text" as const, text }, ...atts])
      : text;
    thread.setMessages((p) => [
      ...p,
      { id: optId, role: "user", content: optimisticContent, created_at: new Date().toISOString(), status: 'pending', metadata: options?.messageMetadata ?? null },
    ]);
    // ADR-0044 — the toolbar's automation-channel chips double as this
    // turn's channel set: whichever of scheduled_task/watcher/bridge are
    // currently shown also get included in the model's context.
    const activeChannels = (["scheduled_task", "watcher", "bridge"] as const)
      .filter((key) => messageFilters.filters[key]);
    const quietRun = !!options?.quiet || hideInternalOperations;
    const { accepted } = await sse.start(
      threadId,
      text,
      {
        filters: {
          include_tools: !quietRun,
          include_thinking: !quietRun,
        },
        ui_experience_mode: state.experienceMode,
      },
      atts.length ? atts : undefined,
      activeChannels,
      thread.hotSinceSeqForRun,
      options?.messageMetadata,
      quietRun,
    );
    if (!accepted) {
      // Server rejected because another run was in flight (second tab,
      // other device). attach() return value feeds our deltas. Roll back
      // the optimistic user bubble and re-queue this message so the
      // drain after the in-flight run's `done` resubmits cleanly.
      thread.setMessages((p) => p.filter((m) => m.id !== optId));
      queueApiRef.current?.prepend(text, atts, options);
      return;
    }
    // Accepted means the server persisted the user row, so "Sending…" is no
    // longer true. Stay unconfirmed until the row is fetched back, otherwise
    // reconciliation can't promote this bubble in place and would duplicate it.
    thread.setMessages((p) => p.map((m) => (m.id === optId ? { ...m, status: 'sent' } : m)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, sse, state.experienceMode, messageFilters.filters]);

  // Hand a mid-run message to the agent that is already streaming (ADR-0080).
  // Mirrors launchRun's optimistic bubble so the composer doesn't silently
  // swallow the message while the run continues.
  //
  // Arm BEFORE the PATCH (not after) so a `done` that races in during that
  // round trip still gets caught by useSSE's consume() loop — but arming
  // alone never touches the live bubble. In the mainline case (preModelHook
  // drains the steer into this same ongoing stream — ADR-0080) the bubble
  // just keeps growing untouched; a visible split only happens reactively,
  // at the point a `done` actually arrives while armed. Steering used to
  // split the bubble here, eagerly, on every attempt — which froze the live
  // answer and blanked it mid-generation even though nothing had actually
  // broken the stream, i.e. almost always.
  const steerRun = useCallback(async (text: string): Promise<boolean> => {
    if (!threadId) return false;
    const optId = `opt-${makeQueuedId("")}`;
    sse.armSteeredContinuation(optId);
    thread.setMessages((p) => [
      ...p,
      { id: optId, role: "user", content: text, created_at: new Date().toISOString(), status: 'steering' },
    ]);
    const { steered } = await api.threads.steerRun(threadId, text);
    if (!steered) {
      thread.setMessages((p) => p.filter((m) => m.id !== optId));
      sse.rollbackSteeredSegment(optId);
    }
    return steered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const queue = useChatQueue({ threadId, streaming: sse.streaming, compacting: sessionCompacting, launchRun });
  queueApiRef.current = queue;
  drainQueueRef.current = queue.drainQueueRef.current;

  async function handleCompact() {
    if (!agentId) return;
    const notifyCompaction = (result: CompactionOutcome) => {
      const toast = compactionOutcomeToast(result);
      pushToast({
        ...toast,
        source: "system",
        sourceLabel: "Chat",
        agent_id: agentId,
        thread_id: threadId,
        ttl: 5000,
        dedupeKey: `compact:${agentId}`,
      });
    };
    setCompacting(true);
    try {
      const result = await api.agents.compact(agentId, { resetContext: true });
      // The thread may have changed while compaction ran; never apply its
      // result to a different thread's view.
      const compactedThreadId = threadId;
      const stillCurrent = () => compactedThreadId !== null && currentThreadIdRef.current === compactedThreadId;
      if (result.compacted && compactedThreadId !== null && stillCurrent()) {
        // Server moved the hot/warm pin to just after the last existing
        // message and persisted the warm summary. Mirror that in-place so
        // the warm card shows the fresh summary without wiping the visible
        // transcript. The user can still scroll up to read prior turns;
        // older history past JARELA_MAX_THREAD_MESSAGES has been pruned
        // server-side but its content lives on inside the warm summary.
        thread.metaApplier.setHotSince(result.hot_since ?? null);
        thread.metaApplier.setHotSinceSeq(result.hot_since_seq ?? null);
        thread.metaApplier.setWarmSummary(result.warm_summary ?? null);
        thread.metaApplier.setWarmSummaryBefore(result.warm_summary_before ?? null);
        thread.metaApplier.setWarmSummaryBeforeSeq(result.warm_summary_before_seq ?? null);
        thread.metaApplier.setWarmSummaryComputedAt(result.warm_summary_computed_at ?? null);
        thread.metaApplier.setWarmSummarySourceMessages(result.warm_summary_source_messages ?? null);
        thread.metaApplier.setWarmSummarySourceChars(result.warm_summary_source_chars ?? null);
        thread.metaApplier.setWarmSummaryTopics?.(parseWarmSummaryTopics(result.warm_summary_topics));
        // The compact response carries only the chat recap; channel recaps
        // (bridge, watcher, scheduled task) come with the thread metadata.
        void api.threads.metadata(compactedThreadId)
          .then((d) => { if (stillCurrent()) applyThreadMeta(thread.metaApplier, d); })
          .catch((err) => console.error("compaction metadata refresh failed", err));
      }
      notifyCompaction(result);
    } catch (err) {
      pushErrorToast({ title: "Compaction failed", error: err, context: { panel: "chat", action: "compact", agent_id: agentId } });
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
    handleProposalResolved,
    queuedMessages,
  } = useChatSubmitHandlers({
    agentId,
    steerRun,
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
  const setThreadMessages = thread.setMessages;

  const retryWithHiddenPrevious = useCallback(async (
    text: string,
    atts: ContentPart[],
    messageId?: string,
  ) => {
    if (messageId && threadId) {
      setThreadMessages((current) => current.map((message) => message.id === messageId
        ? { ...message, metadata: { ...message.metadata, hidden_from_chat: true } }
        : message));
      try {
        await api.threads.setMessageHiddenFromChat(threadId, messageId, true);
      } catch (error) {
        pushErrorToast({
          title: "Could not hide the previous attempt",
          error,
          context: { panel: "chat", action: "message.hide_for_retry", agent_id: agentId, thread_id: threadId },
        });
      }
    }
    handleRetryMessage(text, atts);
  }, [agentId, handleRetryMessage, setThreadMessages, threadId]);

  useFirstRunChatKickoff({
    kickoff: state.firstRunChatKickoff,
    activeTab: state.activeTab,
    agentId,
    threadId,
    sessionLoading: !!sessionLoading,
    messagesLoading: thread.messagesLoading,
    messageCount: currentThreadMessages.length,
    submit: (message, options) => launchRun(message, [], options),
    onConsumed: () => {
      clearFirstRunChatKickoff();
      dispatch({ type: "SET_FIRST_RUN_CHAT_KICKOFF", kickoff: null });
    },
    onError: (error) => pushErrorToast({
      title: "Could not start the setup chat",
      error,
      context: { panel: "chat", action: "first_run_onboarding", agent_id: agentId, thread_id: threadId },
    }),
  });

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col">
      <MessageList
        bottomOverlayHeight={controlsHeight}
        threadId={threadId}
        messages={currentThreadMessages}
        loadingMessages={!!sessionLoading || thread.messagesLoading}
        steeredSegments={sse.steeredSegments}
        agentConfig={agentConfig}
        userProfile={userProfile}
        // streamingContent stays visible past `streaming=false` so the bubble
        // doesn't disappear before the refetch arrives. Cleared atomically
        // via clearStreamingRef once the persisted message lands.
        streamingContent={sse.streamingContent || undefined}
        // Keep the live thinking line visible past `streaming=false` so a
        // user who's still reading isn't yanked out mid-sentence.
        thinkingContent={sse.thinkingContent || undefined}
        // Same reasoning as streamingContent/thinkingContent above: keep the
        // tool trail visible past `streaming=false` so it doesn't flash away
        // before the refetch swaps in the persisted message's tool_events.
        // Cleared atomically alongside clearStreamingRef via handleDone.
        toolEvents={sse.toolEvents.length ? sse.toolEvents : undefined}
        hasMore={thread.hasMore}
        loadingMore={thread.loadingMore}
        onLoadMore={thread.loadOlder}
        queuedMessages={queuedMessages}
        onRemoveQueued={queue.removeQueued}
        hotSinceSeq={thread.hotSinceSeq}
        warmSummary={thread.warmSummary}
        warmSummaryBeforeSeq={thread.warmSummaryBeforeSeq}
        warmSummaryComputedAt={thread.warmSummaryComputedAt}
        warmSummarySourceMessages={thread.warmSummarySourceMessages}
        warmSummarySourceChars={thread.warmSummarySourceChars}
        warmSummaryTopics={thread.warmSummaryTopics}
        warmChannelSummaries={thread.warmChannelSummaries}
        warmSummaryPending={thread.warmSummaryPending}
        compactionPending={thread.compactionPending || sessionCompacting}
        onSetContextPin={thread.setContextPin}
        streaming={sse.streaming}
        contextWindowTokens={thread.contextWindowTokens}
        onRetryMessage={retryWithHiddenPrevious}
        filters={messageFilters.filters}
        hideInternalOperations={hideInternalOperations}
        onToggleFilter={messageFilters.toggle}
        onResetFilters={messageFilters.reset}
      />

      <div ref={controlsRef} className="chat-controls-overlay absolute inset-x-0 bottom-0 z-30">
        <ApprovalsBanner agentId={agentId} onResolved={handleProposalResolved} />
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
            compacting: sessionCompacting,
            sessionLoading: !!sessionLoading,
            streaming: sse.streaming,
          })}
        />
      </div>
    </div>
  );
}
