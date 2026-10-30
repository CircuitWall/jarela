"use client";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Brain, Hourglass, X, ArrowDown, Eye, EyeOff } from "lucide-react";
import type { AgentConfig, AutomationActivityMetadata, ContentPart, Message, SummaryTopicSegment, UserProfile, WarmChannelSummary } from "@/api/types";
import { ToolList, type ToolEvent } from "./ToolList";
import { MessageBubble } from "./MessageBubble";
import { ContextBoundaryDivider, WarmSummaryCard } from "./ContextBoundary";
import { WorkflowStepRetryContext, workflowStepRetryMessage, type WorkflowStepRetryRequest } from "./workflow-step-retry";
import { MESSAGE_FILTER_KEYS, type MessageFilterKey } from "@/hooks/useMessageFilters";
import { CollapseChevron } from "@/components/ui/CollapseChevron";
import { MetaRow } from "@/components/ui/MetaRow";
import { StatusDot } from "@/components/ui/StatusDot";
import { Dialog } from "@/components/ui/Dialog";
import { USAGE_PROFILES } from "@/lib/agents/usage-profile";

interface QueuedMessageView {
  id: string;
  text: string;
  attachmentCount: number;
}

interface SteeredSegment {
  id: string;
  content: string;
}

interface Props {
  bottomOverlayHeight?: number;
  threadId?: string | null;
  messages: Message[];
  steeredSegments?: SteeredSegment[];
  agentConfig?: AgentConfig | null;
  userProfile?: UserProfile | null;
  streamingContent?: string;
  thinkingContent?: string;
  toolEvents?: ToolEvent[];
  hasMore?: boolean;
  loadingMore?: boolean;
  loadingMessages?: boolean;
  onLoadMore?: () => void;
  queuedMessages?: QueuedMessageView[];
  onRemoveQueued?: (id: string) => void;
  // ADR-0042 — explicit context boundary state. The boundary divider is
  // rendered in the message stream right after the last message older than
  // `hotSinceSeq` (or above the first loaded message when the pin sits earlier
  // than the visible window). The timestamp is display-only.
  hotSinceSeq?: number | null;
  warmSummary?: string | null;
  warmSummaryBeforeSeq?: number | null;
  warmSummaryComputedAt?: string | null;
  warmSummarySourceMessages?: number | null;
  warmSummarySourceChars?: number | null;
  warmSummaryTopics?: SummaryTopicSegment[] | null;
  /** Automation-channel recaps committed at the current boundary. */
  warmChannelSummaries?: WarmChannelSummary[];
  warmSummaryPending?: boolean;
  /** An automatic compaction is summarising earlier messages right now. */
  compactionPending?: boolean;
  onSetContextPin?: (hot_since_seq: number | null) => void;
  streaming?: boolean;
  // Thread-level context window cap, forwarded to each MessageBubble so
  // the ContextUsageBar has a baseline for rows whose own usage snapshot
  // predates the per-row column.
  contextWindowTokens?: number | null;
  // Resend a previously-sent user prompt as a new turn. Forwarded to each
  // user-role MessageBubble; absent => retry button is hidden.
  onRetryMessage?: (text: string, attachments: ContentPart[], messageId?: string) => void;
  // Lifted to ChatView (see ADR-0044) so the toolbar's toggle state and the
  // channel set the next run submits with share one source of truth.
  // Optional (defaulting to all-shown, no-op toggle) so callers that don't
  // care about filter behavior — most existing tests — don't need to wire
  // a hook instance just to render the list.
  filters?: Record<MessageFilterKey, boolean>;
  hideInternalOperations?: boolean;
  onToggleFilter?: (key: MessageFilterKey) => void;
  onResetFilters?: () => void;
}

const ALL_FILTERS_SHOWN: Record<MessageFilterKey, boolean> = Object.fromEntries(
  MESSAGE_FILTER_KEYS.map((k) => [k, true]),
) as Record<MessageFilterKey, boolean>;
const NO_CHANNEL_SUMMARIES: WarmChannelSummary[] = [];
const NOOP = () => { };

export function MessageList({ bottomOverlayHeight = 0, threadId, messages, steeredSegments, agentConfig, userProfile, streamingContent, thinkingContent, toolEvents, hasMore, loadingMore, loadingMessages = false, onLoadMore, queuedMessages, onRemoveQueued, hotSinceSeq, warmSummary, warmSummaryBeforeSeq, warmSummaryComputedAt, warmSummarySourceMessages, warmSummarySourceChars, warmSummaryTopics, warmChannelSummaries = NO_CHANNEL_SUMMARIES, warmSummaryPending = false, compactionPending = false, onSetContextPin, streaming, contextWindowTokens, onRetryMessage, filters = ALL_FILTERS_SHOWN, hideInternalOperations = false, onToggleFilter: toggle = NOOP, onResetFilters: reset = NOOP }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

const maskRegionRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visibility = useMessageVisibility({ threadId, reset, hideInternalOperations, agentConfig, streamingContent, thinkingContent, toolEvents, streaming, messages, onRetryMessage, filters });
  const { compactChat, showDiagnostics, summaryPopoverOpen, setSummaryPopoverOpen, hasStreamingContent, displayMessages, retryWorkflowStep, visibleMessages } = visibility;

  const { historyRows } = useHistoryRows({ visibleMessages, steeredSegments, threadId, agentConfig, userProfile, filters, hideInternalOperations, showDiagnostics, contextWindowTokens, hasStreamingContent, onRetryMessage });

  const hiddenCount = displayMessages.length - visibleMessages.length;
  const hasTopControls = visibleMessages.length > 0 || compactChat;
  const controls = useMessageControls(hasTopControls);
  const { topControlsRef, topControlsHeight } = controls;
  const effectiveHotSinceSeq = hotSinceSeq ?? null;
  // The boundary divider only ever renders when a pin is set (see the
  // `hasBoundary` computation below, which is gated on `effectiveHotSinceSeq`).
  // Without this check "Locate boundary line" silently no-ops when there's
  // no pin yet — clicking does nothing and looks like a broken button.
  const hasContextPin = effectiveHotSinceSeq !== null;

  const { atBottomRef, showScrollButton, setShowScrollButton, hasScrollTarget, boundaryAnchorRef, captureBoundaryAnchor, syncScrollButton, scrollTargetIntoView } = useScrollTracking({ displayMessages, streamingContent });

  const focus = useConversationFocus({ scrollRef, visibleMessages, effectiveHotSinceSeq, maskRegionRef, topControlsRef, bottomOverlayHeight, atBottomRef, hostRef, streaming, onSetContextPin, setSummaryPopoverOpen, warmSummary, warmSummaryBeforeSeq });
  const { dragMaskRef, updateBoundaryMask } = focus;

  const { handleScroll } = useScrollAnchors({ scrollRef, atBottomRef, syncScrollButton, displayMessages, streamingContent, updateBoundaryMask, loadingMore, setShowScrollButton, hasScrollTarget, messages, hasMore, onLoadMore, captureBoundaryAnchor, effectiveHotSinceSeq, boundaryAnchorRef });

  const { scrollToBottom, scrollToBoundaryLine } = useTranscriptNavigation({ scrollRef, scrollTargetIntoView, displayMessages, atBottomRef, setShowScrollButton, effectiveHotSinceSeq });

  const overlayStyle: CSSProperties & { "--chat-controls-height": string } = {
    "--chat-controls-height": `${bottomOverlayHeight}px`,
  };

  return (
    <WorkflowStepRetryContext.Provider value={retryWorkflowStep}>
      <div ref={hostRef} className="flex-1 flex flex-col min-h-0 relative" style={overlayStyle}>
        <MessageFilterControls
          {...visibility}
          {...controls}
          hiddenCount={hiddenCount}
          agentConfig={agentConfig}
          filters={filters}
          toggle={toggle}
          onSetContextPin={onSetContextPin}
          scrollToBoundaryLine={scrollToBoundaryLine}
          hasContextPin={hasContextPin}
        />
        <div ref={maskRegionRef} className="relative isolate flex-1 min-h-0 overflow-hidden">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="workspace-gutter chat-message-scroll flex-1 h-full overflow-y-auto overflow-x-hidden panel-scrollbar"
            style={{
              // Edge padding travels with the turns; the viewport itself extends
              // behind both overlays so history remains visible through the frost.
              paddingTop: `calc(3rem + var(--app-safe-top) + ${hasTopControls ? topControlsHeight : 0}px + 1rem)`,
              paddingBottom: "calc(var(--chat-controls-height) + 1rem)",
              scrollPaddingTop: `calc(3rem + var(--app-safe-top) + ${hasTopControls ? topControlsHeight : 0}px + 1rem)`,
              scrollPaddingBottom: "calc(var(--chat-controls-height) + 1rem)",
            }}
          >
            {hasMore && (
              <div className="text-center py-1.5 text-[11px] text-fg-faint select-none">
                {loadingMore ? "Loading earlier messages…" : "Scroll up for earlier messages"}
              </div>
            )}
            {compactionPending && (
              <div className="my-2 flex items-center justify-center gap-2 rounded-lg border border-border bg-surface-2/70 px-3 py-1.5 text-[11px] text-fg-faint select-none">
                <StatusDot tone="accent" size="sm" pulse />
                <span>Summarising earlier messages… this turn still sees the full history.</span>
              </div>
            )}
            <TranscriptEmptyState
              loadingMessages={loadingMessages}
              displayMessages={displayMessages}
              streamingContent={streamingContent}
              streaming={streaming}
              visibleMessages={visibleMessages}
              hiddenCount={hiddenCount}
              reset={reset}
            />
            <FocusedHistoryRows
              {...focus.boundaryProps}
              visibleMessages={visibleMessages}
              warmSummarySourceMessages={warmSummarySourceMessages}
              warmSummarySourceChars={warmSummarySourceChars}
              warmSummary={warmSummary}
              warmSummaryPending={warmSummaryPending}
              onSetContextPin={onSetContextPin}
              streaming={streaming}
              historyRows={historyRows}
            />
            <LiveTurnActivity
              thinkingContent={thinkingContent}
              streamingContent={streamingContent}
              toolEvents={toolEvents}
              filters={hideInternalOperations || !showDiagnostics ? { ...filters, tool_use: false, thinking: false } : filters}
              threadId={threadId ?? null}
              agentConfig={agentConfig ?? null}
              showStreamingAvatar={visibleMessages.length === 0 || visibleMessages[visibleMessages.length - 1].role !== "assistant"}
              streaming={streaming}
            />
            {queuedMessages && queuedMessages.length > 0 && (
              <div className="flex flex-col gap-1 mt-2 mb-1">
                {queuedMessages.map((q) => (
                  <QueuedBubble key={q.id} item={q} onRemove={onRemoveQueued} />
                ))}
              </div>
            )}
          </div>

          <WarmHistoryMask dragMaskRef={dragMaskRef} />
</div>
        <FocusDragOverlay
          {...focus.overlayProps}
          showScrollButton={showScrollButton}
          scrollToBottom={scrollToBottom}
        />
<FocusSummaryDialog
          {...focus.summaryProps}
          summaryPopoverOpen={summaryPopoverOpen}
          setSummaryPopoverOpen={setSummaryPopoverOpen}
          warmChannelSummaries={warmChannelSummaries}
          hasMore={hasMore}
          warmSummary={warmSummary}
          warmSummaryBeforeSeq={warmSummaryBeforeSeq}
          warmSummaryComputedAt={warmSummaryComputedAt}
          streaming={streaming}
          warmSummaryTopics={warmSummaryTopics}
        />
        <FocusMoveDialog
          {...focus.moveProps}

        />
      </div>
    </WorkflowStepRetryContext.Provider>
  );
}

// ADR-0044 — the subset of MESSAGE_FILTER_KEYS that also map to a
// messages.category the model's context is scoped by (see ChatView's
// activeChannels + lib/agents/prepare/history-window.ts). The rest
// (extension, page_capture, synthetic, tool_use, thinking) are display-only.
const CHANNEL_SCOPED_FILTER_KEYS = new Set<MessageFilterKey>(["scheduled_task", "watcher", "bridge"]);
const PROGRAMMATIC_SCROLL_LOCK_MS = 1500;

const CHIP_LABELS: Record<MessageFilterKey, string> = {
  scheduled_task: "scheduled",
  watcher: "watcher",
  bridge: "bridge",
  extension: "extension",
  page_capture: "captures",
  synthetic: "system",
  tool_use: "tools",
  thinking: "thinking",
};

function LiveTurnActivity({
  thinkingContent,
  streamingContent,
  toolEvents,
  filters,
  threadId,
  agentConfig,
  showStreamingAvatar,
  streaming,
}: {
  thinkingContent?: string;
  streamingContent?: string;
  toolEvents?: ToolEvent[];
  filters: Record<MessageFilterKey, boolean>;
  threadId: string | null;
  agentConfig: AgentConfig | null;
  showStreamingAvatar: boolean;
  streaming?: boolean;
}) {
  const showThinking = !!thinkingContent && filters.thinking;
  const showTools = !!toolEvents && toolEvents.length > 0 && filters.tool_use;
  const hasTools = !!toolEvents?.length;
  // Until the first delta lands there is nothing else to render, and the
  // conversation would otherwise sit empty while the model works.
  const showDots = !!streaming && !showThinking && !streamingContent && !showTools;
  if (!showThinking && !streamingContent && !hasTools && !showDots) return null;
  return (
    <div data-testid="live-turn-activity" className="mt-1 flex w-full min-w-0 flex-col gap-1">
      {showDots && <div className="min-w-0 pl-9"><ThinkingDots /></div>}
      {showThinking && <div className="min-w-0 pl-9"><ThinkingLine text={thinkingContent} /></div>}
      {streamingContent && (
        <StreamingBubble
          content={streamingContent}
          threadId={threadId}
          agentConfig={agentConfig}
          showAvatar={showStreamingAvatar}
        />
      )}
      {!!toolEvents?.length && <div className="min-w-0 pl-9"><ToolList events={toolEvents} errorsOnly={!showTools} /></div>}
    </div>
  );
}

const HistoryRow = memo(function HistoryRow({
  message, steeredSegment, segmentShowAvatar, attachedActivity, startsTurn, separated,
  threadId, agentConfig, userProfile, showToolEvents, showDiagnostics, contextWindowTokens, isLatest, onRetry,
}: {
  message: Message;
  steeredSegment?: SteeredSegment;
  segmentShowAvatar: boolean;
  attachedActivity?: AutomationActivityMetadata;
  startsTurn: boolean;
  separated: boolean;
  threadId: string | null;
  agentConfig?: AgentConfig | null;
  userProfile?: UserProfile | null;
  showToolEvents: boolean;
  showDiagnostics: boolean;
  contextWindowTokens: number | null;
  isLatest: boolean;
  onRetry?: Props["onRetryMessage"];
}) {
  return (
    <>
      {steeredSegment && (
        <StreamingBubble
          content={steeredSegment.content}
          threadId={threadId}
          agentConfig={agentConfig ?? null}
          showAvatar={segmentShowAvatar}
        />
      )}
      <div
        id={typeof message.seq === "number" ? String(message.seq) : `msg-${message.id}`}
        data-message-id={message.id}
        data-hot-candidate="1"
        data-message-seq={message.seq}
        data-created-at={message.created_at}
        className={separated ? "mt-3" : undefined}
      >
        <MessageBubble
          message={message}
          attachedActivity={attachedActivity}
          threadId={threadId}
          agentConfig={agentConfig}
          userProfile={userProfile}
          showAvatar={startsTurn}
          showToolEvents={showToolEvents}
          showDiagnostics={showDiagnostics}
          contextWindowTokens={contextWindowTokens}
          isLatest={isLatest}
          onRetry={onRetry}
        />
      </div>
    </>
  );
});

// Keep the synthetic message identity stable when only the parent updates.
const StreamingBubble = memo(function StreamingBubble({
  content,
  threadId,
  agentConfig,
  showAvatar,
}: {
  content: string;
  threadId: string | null;
  agentConfig: AgentConfig | null;
  showAvatar: boolean;
}) {
  const message = useMemo(
    () => ({ role: "assistant" as const, content, streaming: true }),
    [content],
  );
  return (
    <MessageBubble
      message={message}
      threadId={threadId}
      agentConfig={agentConfig}
      showAvatar={showAvatar}
    />
  );
});

function ThinkingDots() {
  return (
    <div
      data-testid="thinking-dots"
      role="status"
      aria-label="Thinking"
      className="flex items-center gap-1.5 px-1 py-1.5 text-fg-faint"
    >
      <span className="jarela-thinking-dot" />
      <span className="jarela-thinking-dot" />
      <span className="jarela-thinking-dot" />
    </div>
  );
}

function ThinkingLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, " ").trim();
  const tail = preview.length > 60 ? preview.slice(-60) : preview;
  return (
    <div className="w-full min-w-0 max-w-full flex flex-col items-start gap-0.5">
      <MetaRow accent="amber" fullWidth onClick={() => setOpen((v) => !v)} expanded={open} aria-label="toggle thinking details">
        <CollapseChevron open={open} size={9} />
        <Brain size={11} className="shrink-0" aria-hidden />
        <span className="font-medium">thinking</span>
        {!open && <span className="truncate italic opacity-60 flex-1 min-w-0 text-left">{tail}</span>}
      </MetaRow>
      {open && (
        <pre className="w-full px-2 py-1.5 text-[10px] text-fg-muted whitespace-pre-wrap break-words font-mono bg-surface-2/40 rounded border border-border/40">
          {text}
        </pre>
      )}
    </div>
  );
}

// Ghosted user-bubble shown for messages the user typed while a previous run
// was still streaming. The chat input doesn't block; submissions stack up here
// and drain automatically as the agent finishes each turn. Click X to remove
// before it fires.
function QueuedBubble({
  item, onRemove,
}: {
  item: { id: string; text: string; attachmentCount: number };
  onRemove?: (id: string) => void;
}) {
  return (
    <div className="flex flex-row-reverse gap-2 items-end opacity-60 group">
      <div className="shrink-0 w-7" />
      <div className="max-w-[75%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm leading-relaxed bg-accent/40 border border-accent/40 border-dashed text-fg relative">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-accent/80 mb-1">
          <Hourglass size={10} />
          <span>queued</span>
          {item.attachmentCount > 0 && (
            <span className="text-fg-muted/70 normal-case tracking-normal">
              · {item.attachmentCount} attachment{item.attachmentCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <p className="whitespace-pre-wrap break-words">{item.text}</p>
        {onRemove && (
          <button
            onClick={() => onRemove(item.id)}
            className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-surface-3 border border-border text-fg-muted hover:text-rose-700 dark:hover:text-rose-400 hover:border-rose-700 hidden group-hover:flex items-center justify-center"
            title="Remove from queue"
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

function useFocusDragState() {
  const dragPointerIdRef = useRef<number | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const autoScrollLockRef = useRef<-1 | 0 | 1>(0);
  const autoScrollVelocityRef = useRef(0);
  const autoScrollPointerYRef = useRef<number | null>(null);
  const dragYRef = useRef<number | null>(null);
  const dragStartYRef = useRef<number | null>(null);
  const dragMovedRef = useRef(false);
  const suppressBoundaryClickRef = useRef(false);
  const dragGuideTopRef = useRef<number | null>(null);
  const dragGuideRef = useRef<HTMLDivElement>(null);
  const dragGuideStatsRef = useRef<HTMLSpanElement>(null);
  const dragMaskRef = useRef<HTMLDivElement>(null);
  const previewHotSinceSeqRef = useRef<number | null>(null);
  const [isDraggingFocus, setIsDraggingFocus] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingHotSinceSeq, setPendingHotSinceSeq] = useState<number | null>(null);
  useEffect(() => {
    return () => {
      for (const frame of [dragFrameRef, autoScrollFrameRef]) {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
      }
    };
  }, []);

return {

dragPointerIdRef, dragFrameRef, autoScrollFrameRef, autoScrollLockRef,

autoScrollVelocityRef, autoScrollPointerYRef, dragYRef, dragStartYRef,

dragMovedRef, suppressBoundaryClickRef, dragGuideTopRef, dragGuideRef,

dragGuideStatsRef, dragMaskRef, previewHotSinceSeqRef, isDraggingFocus,

setIsDraggingFocus, confirmOpen, setConfirmOpen, pendingHotSinceSeq,

setPendingHotSinceSeq,

};
}

function useMessageVisibility({
  threadId, reset, hideInternalOperations, agentConfig,
  streamingContent, thinkingContent, toolEvents, streaming,
  messages, onRetryMessage, filters,
}: {
  threadId: Props["threadId"];
  reset: () => void;
  hideInternalOperations: boolean;
  agentConfig: AgentConfig | null | undefined;
  streamingContent: string | undefined;
  thinkingContent: string | undefined;
  toolEvents: ToolEvent[] | undefined;
  streaming: boolean | undefined;
  messages: Message[];
  onRetryMessage: ((text: string, attachments: ContentPart[], messageId?: string) => void) | undefined;
  filters: Record<"scheduled_task" | "watcher" | "bridge" | "extension" | "page_capture" | "synthetic" | "tool_use" | "thinking", boolean>;
}) {
  const [revealedForAgent, setRevealedForAgent] = useState<string | null>(null);
  const autoRecoveredRef = useRef<string | null>(null);
  const compactChat = USAGE_PROFILES[agentConfig?.usage_profile ?? "custom"].compactChat;
  const showDiagnostics = !compactChat || (!!agentConfig && revealedForAgent === agentConfig.id);
  const [summaryPopoverOpen, setSummaryPopoverOpen] = useState(false);
  const hasStreamingContent = !!streamingContent;
  const hasThinkingContent = !!thinkingContent;
  const hasLiveToolEvents = !!toolEvents?.length;
  const hidePersistedDraft = !!streaming || hasStreamingContent;
  const displayMessages = useMemo(
    () => messages.filter((message) => message.metadata?.hidden_from_chat !== true),
    [messages],
  );

  const retryWorkflowStep = useMemo(
    () => onRetryMessage
      ? (request: WorkflowStepRetryRequest) => onRetryMessage(workflowStepRetryMessage(request), [])
      : null,
    [onRetryMessage],
  );

  // Apply category filter. Messages with no `category` (NULL = ordinary
  // chat) are always shown; tagged messages are gated by their toggle.
  // The `tool_use` and `thinking` filters do NOT remove whole messages —
  // they're handled below by gating the inline ToolList / ThinkingLine.
  const visibleMessages = useMemo(() => {
    return displayMessages.filter((m) => {
      if (m.role === "assistant" && m.transcript_status === "in_progress" && hidePersistedDraft) return false;
      const key = categoryFilterKey(m.category);
      return key === null || filters[key];
    });
  }, [displayMessages, hidePersistedDraft, filters]);

  const hiddenCount = displayMessages.length - visibleMessages.length;
  // Self-heal stale/accidental filter states that blank an entire thread.
  // If a thread has persisted messages but every one is filtered out, users
  // perceive this as "chat is empty". Auto-reset once per thread snapshot so
  // content remains visible without requiring manual recovery.
  useEffect(() => {
    if (displayMessages.length === 0 || hasStreamingContent) return;
    if (visibleMessages.length > 0) return;
    if (hiddenCount !== displayMessages.length) return;
    const lastId = displayMessages[displayMessages.length - 1]?.id ?? "none";
    const key = `${threadId ?? "no-thread"}:${displayMessages.length}:${lastId}`;
    if (autoRecoveredRef.current === key) return;
    autoRecoveredRef.current = key;
    reset();
  }, [threadId, displayMessages, visibleMessages.length, hiddenCount, hasStreamingContent, reset]);

  // Surface a category chip in the toolbar only if it can actually do
  // something useful right now: scheduled_task/bridge/synthetic chips
  // appear only when at least one such message exists in the loaded
  // transcript; tool_use appears when any assistant message has tool
  // events; thinking appears when there's live thinking content (the
  // only place it currently surfaces).
  const availableChips = useMemo(() => {
    const set = new Set<MessageFilterKey>();
    for (const m of displayMessages) {
      const key = categoryFilterKey(m.category);
      if (key) set.add(key);
      if (m.tool_events && m.tool_events.length > 0) set.add("tool_use");
    }
    if (hasThinkingContent) set.add("thinking");
    if (hasLiveToolEvents) set.add("tool_use");
    return MESSAGE_FILTER_KEYS.filter((key) =>
      set.has(key) && !(hideInternalOperations && (key === "tool_use" || key === "thinking")),
    );
  }, [displayMessages, hasThinkingContent, hasLiveToolEvents, hideInternalOperations]);

return {

availableChips, setRevealedForAgent, compactChat, showDiagnostics,

summaryPopoverOpen, setSummaryPopoverOpen, hasStreamingContent, hasThinkingContent,

hasLiveToolEvents, displayMessages, retryWorkflowStep, visibleMessages,

};
}

function useHistoryRows({
  visibleMessages, steeredSegments, threadId, agentConfig,
  userProfile, filters, hideInternalOperations, showDiagnostics,
  contextWindowTokens, hasStreamingContent, onRetryMessage,
}: {
  visibleMessages: Message[];
  steeredSegments: SteeredSegment[] | undefined;
  threadId: string | null | undefined;
  agentConfig: AgentConfig | null | undefined;
  userProfile: UserProfile | null | undefined;
  filters: Record<"scheduled_task" | "watcher" | "bridge" | "extension" | "page_capture" | "synthetic" | "tool_use" | "thinking", boolean>;
  hideInternalOperations: boolean;
  showDiagnostics: boolean;
  contextWindowTokens: number | null | undefined;
  hasStreamingContent: boolean;
  onRetryMessage: ((text: string, attachments: ContentPart[], messageId?: string) => void) | undefined;
}) {
  const historyRows = useMemo(() => {
    const attachedActivities = new Map<string, AutomationActivityMetadata>();
    const hiddenActivityIds = new Set<string>();
    for (let i = 0; i < visibleMessages.length - 1; i++) {
      const activityMessage = visibleMessages[i];
      const activity = activityMessage.metadata?.automation_activity;
      if (!activity) continue;
      const related = visibleMessages[i + 1];
      const matches = !related.metadata?.automation_activity && (
        activity.source_kind === "bridge"
          ? related.role === "user"
          && related.metadata?.bridge_conversation?.key === activity.source_id
          : related.role === "assistant" && related.category === activity.source_kind
      );
      if (!matches) continue;
      attachedActivities.set(related.id, activity);
      hiddenActivityIds.add(activityMessage.id);
    }
    const segmentsById = new Map(steeredSegments?.map((segment) => [segment.id, segment]));
    const startsTurns = new Map<string, boolean>();
    let previousRole: Message["role"] | null = null;
    for (const message of visibleMessages) {
      if (hiddenActivityIds.has(message.id)) continue;
      startsTurns.set(message.id, previousRole === null || previousRole !== message.role);
      previousRole = message.role;
    }
    return visibleMessages.map((msg, i) => {
      if (hiddenActivityIds.has(msg.id)) return null;
      const startsTurn = startsTurns.get(msg.id) ?? false;
      const steeredSegment = segmentsById.get(msg.id);
      return (
        <HistoryRow
          key={msg.id}
          message={msg}
          steeredSegment={steeredSegment}
          segmentShowAvatar={i === 0 || visibleMessages[i - 1].role !== "assistant"}
          attachedActivity={attachedActivities.get(msg.id)}
          startsTurn={startsTurn}
          separated={startsTurn && i > 0}
          threadId={threadId ?? null}
          agentConfig={agentConfig}
          userProfile={userProfile}
          showToolEvents={filters.tool_use && !hideInternalOperations}
          showDiagnostics={showDiagnostics && !hideInternalOperations}
          contextWindowTokens={contextWindowTokens ?? null}
          isLatest={i === visibleMessages.length - 1 && !hasStreamingContent}
          onRetry={onRetryMessage}
        />
      );
    });
  }, [visibleMessages, steeredSegments, threadId, agentConfig, userProfile, filters, hideInternalOperations, showDiagnostics, contextWindowTokens, hasStreamingContent, onRetryMessage]);

  return { historyRows };
}

function useFocusGeometry({ scrollRef, visibleMessages, effectiveHotSinceSeq, dragMaskRef, maskRegionRef }: {
  scrollRef: import("react").RefObject<HTMLDivElement | null>;
  visibleMessages: Message[];
  effectiveHotSinceSeq: number | null;
  dragMaskRef: import("react").RefObject<HTMLDivElement | null>;
  maskRegionRef: import("react").RefObject<HTMLDivElement | null>;
}) {
  function pickHotSinceSeqFromPointerY(clientY: number): number | null {
    const root = scrollRef.current;
    if (!root || visibleMessages.length === 0) return effectiveHotSinceSeq;
    const candidates = Array.from(root.querySelectorAll<HTMLElement>("[data-hot-candidate='1'][data-message-seq]"));
    if (candidates.length === 0) return effectiveHotSinceSeq;

    // Use on-screen message positions (midpoints between consecutive rows)
    // so small drags move the boundary locally instead of jumping by a large
    // ratio across the entire loaded transcript.
    for (let i = 0; i < candidates.length - 1; i++) {
      const currentTop = candidates[i].getBoundingClientRect().top;
      const nextTop = candidates[i + 1].getBoundingClientRect().top;
      const midpoint = currentTop + (nextTop - currentTop) / 2;
      if (clientY < midpoint) return Number(candidates[i].dataset.messageSeq);
    }
    const lastCandidate = candidates[candidates.length - 1];
    const lastSeq = Number(lastCandidate?.dataset.messageSeq);
    return Number.isFinite(lastSeq) ? lastSeq : effectiveHotSinceSeq;
  }

  const boundaryIndexFor = useCallback((seq: number | null = effectiveHotSinceSeq): number => {
    if (seq === null || visibleMessages.length === 0) return -1;
    // Warm is inclusive: everything with seq < hot_since_seq. The line sits
    // directly below the last warm message, so anything after it — including
    // optimistic rows that have no seq yet — is always rendered as hot.
    let lastWarm = -1;
    for (let i = 0; i < visibleMessages.length; i++) {
      const s = visibleMessages[i].seq;
      if (typeof s === "number" && s < seq) lastWarm = i;
    }
    return lastWarm + 1;
  }, [effectiveHotSinceSeq, visibleMessages]);

  function countOlderForHotSince(seq: number | null = effectiveHotSinceSeq): number {
    const index = boundaryIndexFor(seq);
    return index < 0 ? 0 : index;
  }

  function lineStatsForHotSince(seq: number | null = effectiveHotSinceSeq): string {
    const older = countOlderForHotSince(seq);
    const recent = Math.max(0, visibleMessages.length - older);
    return `recent ${recent} · warm ${older}`;
  }

  const updateBoundaryMask = useCallback(() => {
    const mask = dragMaskRef.current;
    if (!mask) return;
    const root = scrollRef.current;
    const region = maskRegionRef.current;
    if (!root || !region) return;
    const first = root.querySelector<HTMLElement>("[data-hot-candidate='1']");
    const topStart = first ? first.getBoundingClientRect().top - region.getBoundingClientRect().top : null;
    const boundary = root.querySelector<HTMLElement>("[data-focus-boundary='1'] [aria-label='conversation focus boundary']");
    let boundaryTop: number | null = null;
    if (boundary) {
      const rect = boundary.getBoundingClientRect();
      boundaryTop = rect.top + (rect.height / 2) - region.getBoundingClientRect().top;
    } else {
      const candidates = Array.from(root.querySelectorAll<HTMLElement>("[data-hot-candidate='1']"));
      if (candidates.length > 0 && visibleMessages.length > 0) {
        const regionTop = region.getBoundingClientRect().top;
        const targetIndex = boundaryIndexFor(effectiveHotSinceSeq);
        if (effectiveHotSinceSeq === null || targetIndex < 0 || targetIndex >= visibleMessages.length) {
          boundaryTop = candidates[candidates.length - 1].getBoundingClientRect().bottom - regionTop;
        } else {
          const target = candidates[targetIndex];
          boundaryTop = target ? target.getBoundingClientRect().top - regionTop : null;
        }
      }
    }
    if (topStart === null || boundaryTop === null) {
      mask.style.opacity = "0";
      mask.style.height = "0px";
      return;
    }

    const regionRect = region.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const viewportTop = Math.max(0, rootRect.top - regionRect.top);
    const viewportBottom = Math.min(regionRect.height, rootRect.bottom - regionRect.top);
    const rawTop = Math.min(topStart, boundaryTop);
    const rawBottom = Math.max(topStart, boundaryTop);
    const top = Math.max(rawTop, viewportTop);
    const bottom = Math.min(rawBottom, viewportBottom);
    const height = Math.max(0, bottom - top);
    if (height < 2) {
      mask.style.opacity = "0";
      mask.style.height = "0px";
      return;
    }

    mask.style.transform = `translateY(${top}px)`;
    mask.style.height = `${height}px`;
    mask.style.borderBottom = boundaryTop >= viewportTop && boundaryTop <= viewportBottom
      ? "1px solid rgba(59,130,246,0.42)"
      : "0";
    mask.style.opacity = "1";
  }, [boundaryIndexFor, dragMaskRef, effectiveHotSinceSeq, maskRegionRef, scrollRef, visibleMessages.length]);

  return { pickHotSinceSeqFromPointerY, boundaryIndexFor, countOlderForHotSince, lineStatsForHotSince, updateBoundaryMask };
}

function useFocusAutoScroll({
  topControlsRef, bottomOverlayHeight, scrollRef, autoScrollFrameRef,
  autoScrollVelocityRef, autoScrollPointerYRef, scheduleDragFromPointer, autoScrollLockRef,
  atBottomRef,
}: {
  topControlsRef: import("react").RefObject<HTMLDivElement | null>;
  bottomOverlayHeight: number;
  scrollRef: import("react").RefObject<HTMLDivElement | null>;
  autoScrollFrameRef: import("react").RefObject<number | null>;
  autoScrollVelocityRef: import("react").RefObject<number>;
  autoScrollPointerYRef: import("react").RefObject<number | null>;
  scheduleDragFromPointer: (clientY: number) => void;
  autoScrollLockRef: import("react").RefObject<0 | 1 | -1>;
  atBottomRef: import("react").RefObject<boolean>;
}) {
  function unobscuredScrollBounds(scroller: HTMLDivElement) {
    const rect = scroller.getBoundingClientRect();
    const top = Math.max(rect.top, topControlsRef.current?.getBoundingClientRect().bottom ?? rect.top);
    const bottom = Math.max(top + 1, rect.bottom - bottomOverlayHeight);
    return { top, bottom, height: bottom - top };
  }

  function stepAutoScroll() {
    const scroller = scrollRef.current;
    if (!scroller) {
      autoScrollFrameRef.current = null;
      return;
    }
    const velocity = autoScrollVelocityRef.current;
    if (velocity === 0) {
      autoScrollFrameRef.current = null;
      return;
    }

    const prevTop = scroller.scrollTop;
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const nextTop = Math.max(0, Math.min(maxTop, prevTop + velocity));
    scroller.scrollTop = nextTop;

    const pointerY = autoScrollPointerYRef.current;
    if (pointerY !== null) {
      const rect = unobscuredScrollBounds(scroller);
      const clampedY = Math.max(rect.top + 1, Math.min(rect.bottom - 1, pointerY));
      scheduleDragFromPointer(clampedY);
    }

    if (Math.abs(nextTop - prevTop) < 0.1 && (nextTop === 0 || nextTop === maxTop)) {
      autoScrollFrameRef.current = null;
      return;
    }
    autoScrollFrameRef.current = requestAnimationFrame(stepAutoScroll);
  }

  function updateAutoScrollFromPointer(clientY: number) {
    autoScrollPointerYRef.current = clientY;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const rect = unobscuredScrollBounds(scroller);
    const edge = Math.min(180, Math.max(72, rect.height * 0.24));
    const release = edge + 18;
    let lock = autoScrollLockRef.current;

    if (lock === -1 && clientY > rect.top + release) lock = 0;
    if (lock === 1 && clientY < rect.bottom - release) lock = 0;
    if (lock === 0) {
      if (clientY < rect.top + edge) lock = -1;
      else if (clientY > rect.bottom - edge) lock = 1;
    }

    autoScrollLockRef.current = lock;
    let velocity = 0;

    if (lock === -1) {
      const depth = Math.max(0, rect.top + edge - clientY);
      const t = Math.min(1, depth / edge);
      velocity = -(2 + (t * t * 26));
    } else if (lock === 1) {
      const depth = Math.max(0, clientY - (rect.bottom - edge));
      const t = Math.min(1, depth / edge);
      velocity = 2 + (t * t * 26);
    }

    autoScrollVelocityRef.current = velocity;
    if (velocity !== 0 && autoScrollFrameRef.current === null) {
      atBottomRef.current = false;
      autoScrollFrameRef.current = requestAnimationFrame(stepAutoScroll);
    }
  }

  return { unobscuredScrollBounds, updateAutoScrollFromPointer };
}

function useFocusDragging({
  dragFrameRef, autoScrollFrameRef, autoScrollLockRef, autoScrollVelocityRef,
  autoScrollPointerYRef, dragYRef, dragStartYRef, dragMovedRef,
  dragPointerIdRef, previewHotSinceSeqRef, dragGuideTopRef, setIsDraggingFocus,
  dragGuideRef, dragGuideStatsRef, updateBoundaryMask, topControlsRef,
  bottomOverlayHeight, scrollRef, atBottomRef, hostRef,
  pickHotSinceSeqFromPointerY, lineStatsForHotSince, effectiveHotSinceSeq, setPendingHotSinceSeq,
  setConfirmOpen, streaming, onSetContextPin, suppressBoundaryClickRef,
  setSummaryPopoverOpen,
}: {
  dragFrameRef: import("react").RefObject<number | null>;
  autoScrollFrameRef: import("react").RefObject<number | null>;
  autoScrollLockRef: import("react").RefObject<0 | 1 | -1>;
  autoScrollVelocityRef: import("react").RefObject<number>;
  autoScrollPointerYRef: import("react").RefObject<number | null>;
  dragYRef: import("react").RefObject<number | null>;
  dragStartYRef: import("react").RefObject<number | null>;
  dragMovedRef: import("react").RefObject<boolean>;
  dragPointerIdRef: import("react").RefObject<number | null>;
  previewHotSinceSeqRef: import("react").RefObject<number | null>;
  dragGuideTopRef: import("react").RefObject<number | null>;
  setIsDraggingFocus: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  dragGuideRef: import("react").RefObject<HTMLDivElement | null>;
  dragGuideStatsRef: import("react").RefObject<HTMLSpanElement | null>;
  updateBoundaryMask: () => void;
  topControlsRef: import("react").RefObject<HTMLDivElement | null>;
  bottomOverlayHeight: number;
  scrollRef: import("react").RefObject<HTMLDivElement | null>;
  atBottomRef: import("react").RefObject<boolean>;
  hostRef: import("react").RefObject<HTMLDivElement | null>;
  pickHotSinceSeqFromPointerY: (clientY: number) => number | null;
  lineStatsForHotSince: (seq?: number | null) => string;
  effectiveHotSinceSeq: number | null;
  setPendingHotSinceSeq: import("react").Dispatch<import("react").SetStateAction<number | null>>;
  setConfirmOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  streaming: boolean | undefined;
  onSetContextPin: ((hot_since_seq: number | null) => void) | undefined;
  suppressBoundaryClickRef: import("react").RefObject<boolean>;
  setSummaryPopoverOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
}) {
  function clearDragState() {
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    if (autoScrollFrameRef.current !== null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
    autoScrollLockRef.current = 0;
    autoScrollVelocityRef.current = 0;
    autoScrollPointerYRef.current = null;
    dragYRef.current = null;
    dragStartYRef.current = null;
    dragMovedRef.current = false;
    dragPointerIdRef.current = null;
    previewHotSinceSeqRef.current = null;
    dragGuideTopRef.current = null;
    setIsDraggingFocus(false);
    if (dragGuideRef.current) dragGuideRef.current.style.opacity = "0";
    if (dragGuideStatsRef.current) dragGuideStatsRef.current.textContent = "";
    requestAnimationFrame(() => updateBoundaryMask());
  }

  const { unobscuredScrollBounds, updateAutoScrollFromPointer } = useFocusAutoScroll({ topControlsRef, bottomOverlayHeight, scrollRef, autoScrollFrameRef, autoScrollVelocityRef, autoScrollPointerYRef, scheduleDragFromPointer, autoScrollLockRef, atBottomRef });

  function updateDragFromPointer(clientY: number) {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const rect = unobscuredScrollBounds(scroller);
    const clampedY = Math.max(rect.top + 1, Math.min(rect.bottom - 1, clientY));

    const hostTop = hostRef.current?.getBoundingClientRect().top;
    if (hostTop !== undefined && dragGuideRef.current) {
      const guideTop = clampedY - hostTop;
      dragGuideTopRef.current = guideTop;
      dragGuideRef.current.style.transform = `translateY(${guideTop}px)`;
      dragGuideRef.current.style.opacity = "1";
    }

    const next = pickHotSinceSeqFromPointerY(clampedY);
    if (previewHotSinceSeqRef.current !== next) {
      previewHotSinceSeqRef.current = next;
      if (dragGuideStatsRef.current) {
        dragGuideStatsRef.current.textContent = lineStatsForHotSince(next);
      }
    }
    updateBoundaryMask();
  }

  function scheduleDragFromPointer(clientY: number) {
    dragYRef.current = clientY;
    if (dragFrameRef.current !== null) return;
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null;
      if (dragYRef.current === null) return;
      updateDragFromPointer(dragYRef.current);
    });
  }

  function commitDragCandidate(next: number | null) {
    clearDragState();
    if (next === null || next === effectiveHotSinceSeq) return;
    setPendingHotSinceSeq(next);
    setConfirmOpen(true);
  }

  function handleBoundaryPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (streaming || !onSetContextPin) return;
    atBottomRef.current = false;
    dragPointerIdRef.current = e.pointerId;
    dragStartYRef.current = e.clientY;
    dragMovedRef.current = false;
    previewHotSinceSeqRef.current = effectiveHotSinceSeq;
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDraggingFocus(true);
    updateAutoScrollFromPointer(e.clientY);
    scheduleDragFromPointer(e.clientY);
  }

  function handleBoundaryPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    if (dragPointerIdRef.current !== e.pointerId) return;
    if (dragStartYRef.current !== null && Math.abs(e.clientY - dragStartYRef.current) > 3) {
      dragMovedRef.current = true;
    }
    updateAutoScrollFromPointer(e.clientY);
    scheduleDragFromPointer(e.clientY);
  }

  function handleBoundaryPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    if (dragPointerIdRef.current !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!dragMovedRef.current) {
      suppressBoundaryClickRef.current = true;
      requestAnimationFrame(() => {
        suppressBoundaryClickRef.current = false;
      });
      setSummaryPopoverOpen((x) => !x);
      clearDragState();
      return;
    }
    const y = dragYRef.current ?? e.clientY;
    const next = pickHotSinceSeqFromPointerY(y);
    suppressBoundaryClickRef.current = true;
    requestAnimationFrame(() => {
      suppressBoundaryClickRef.current = false;
    });
    commitDragCandidate(next);
  }

  function handleBoundaryPointerCancel(e: React.PointerEvent<HTMLButtonElement>) {
    if (dragPointerIdRef.current !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    clearDragState();
  }

  function handleBoundaryClick(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    if (suppressBoundaryClickRef.current) return;
    setSummaryPopoverOpen((x) => !x);
  }

  return { handleBoundaryPointerDown, handleBoundaryPointerMove, handleBoundaryPointerUp, handleBoundaryPointerCancel, handleBoundaryClick };
}

function useScrollTracking({ displayMessages, streamingContent }: {
  displayMessages: Message[];
  streamingContent: string | undefined;
}) {
  // Tracks whether the user was at the bottom on the most recent scroll event.
  // After every render, if true, we snap to bottom — which means: while the
  // user is at the bottom they "follow" automatically; if they scroll away,
  // they stay where they are; when they scroll back to the bottom they resume
  // following. No timers, no growth checks, no programmatic-scroll guards —
  // the only signal is the user's own scroll position. CSS `overflow-anchor`
  // (browser-default) handles the pagination case (older content prepended
  // keeps visible content stable).
  const atBottomRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const hasScrollTarget = displayMessages.length > 0 || !!streamingContent;

  // Anchor for the warm/hot boundary line relocating. When `hotSince`
  // moves (manual drag, /compact, or an automatic re-anchor), the inline
  // `ContextBoundaryDivider` jumps to a different message index — but
  // total `scrollHeight` doesn't change (it's the same divider, just
  // relocated), so neither the bottom-follow effect above nor the
  // pagination anchor below catches it, and a user scrolled up watches
  // the view appear to shift without touching their scroll. Captured on
  // every real scroll (handleScroll), consumed by the hotSince-keyed
  // layout effect further down.
  const boundaryAnchorRef = useRef<{ id: string; top: number } | null>(null);
  const captureBoundaryAnchor = useCallback((el: HTMLDivElement) => {
    if (atBottomRef.current) { boundaryAnchorRef.current = null; return; }
    const containerTop = el.getBoundingClientRect().top;
    const nodes = el.querySelectorAll<HTMLElement>("[data-message-id]");
    for (const node of nodes) {
      const top = node.getBoundingClientRect().top - containerTop;
      if (top >= -4) {
        boundaryAnchorRef.current = { id: node.dataset.messageId ?? "", top };
        return;
      }
    }
    boundaryAnchorRef.current = null;
  }, []);

  // While a programmatic smooth scroll (locate boundary, deep link) animates
  // away from the bottom, its first frames are still "near bottom". Without
  // this lock, scroll sync re-arms bottom-follow and the post-render snap
  // cancels the animation, so the target is never reached.
  const programmaticScrollUntilRef = useRef(0);
  const syncScrollButton = useCallback((el: HTMLDivElement) => {
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    const locked = Date.now() < programmaticScrollUntilRef.current;
    atBottomRef.current = isAtBottom && !locked;
    setShowScrollButton(!atBottomRef.current && hasScrollTarget);
  }, [hasScrollTarget]);

  const scrollTargetIntoView = useCallback((target: HTMLElement) => {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    programmaticScrollUntilRef.current = Date.now() + (reducedMotion ? 0 : PROGRAMMATIC_SCROLL_LOCK_MS);
    atBottomRef.current = false;
    setShowScrollButton(hasScrollTarget);
    target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    target.classList.add("jarela-deep-link-flash");
    window.setTimeout(() => target.classList.remove("jarela-deep-link-flash"), 1600);
  }, [hasScrollTarget]);

  return {

    atBottomRef, showScrollButton, setShowScrollButton, hasScrollTarget,

    boundaryAnchorRef, captureBoundaryAnchor, syncScrollButton, scrollTargetIntoView,

  };
}

function useScrollAnchors({
  scrollRef, atBottomRef, syncScrollButton, displayMessages,
  streamingContent, updateBoundaryMask, loadingMore, setShowScrollButton,
  hasScrollTarget, messages, hasMore, onLoadMore,
  captureBoundaryAnchor, effectiveHotSinceSeq, boundaryAnchorRef,
}: {
  scrollRef: import("react").RefObject<HTMLDivElement | null>;
  atBottomRef: import("react").RefObject<boolean>;
  syncScrollButton: (el: HTMLDivElement) => void;
  displayMessages: Message[];
  streamingContent: string | undefined;
  updateBoundaryMask: () => void;
  loadingMore: boolean | undefined;
  setShowScrollButton: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  hasScrollTarget: boolean;
  messages: Message[];
  hasMore: boolean | undefined;
  onLoadMore: (() => void) | undefined;
  captureBoundaryAnchor: (el: HTMLDivElement) => void;
  effectiveHotSinceSeq: number | null;
  boundaryAnchorRef: import("react").RefObject<{ id: string; top: number; } | null>;
}) {
  // Anchor for older-message pagination. When the user scrolls near the top
  // and we call onLoadMore, we snapshot the viewport (scrollHeight + scrollTop)
  // here. After the parent prepends the new messages and React commits, the
  // layout effect below compensates scrollTop by the height delta so the
  // content the user was looking at stays at the same on-screen position
  // instead of remaining pinned to scrollTop=0 (which makes the viewport
  // "jump" to the very oldest message).
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Don't snap to bottom while we're in the middle of restoring scroll
    // after a load-more prepend — the layout effect below owns scrollTop
    // until the anchor is consumed.
    if (prependAnchorRef.current) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }); // intentionally no deps — runs after every render

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || atBottomRef.current || prependAnchorRef.current) return;
    syncScrollButton(el);
  }, [atBottomRef, displayMessages.length, scrollRef, streamingContent, syncScrollButton]);

  // Keep the bottom pinned when the scroll container *itself* resizes —
  // not just when messages change. When the on-screen keyboard opens,
  // `100dvh` shrinks AppShell, which shrinks this container without
  // triggering a React render, so the post-render effect above never
  // fires. Without this observer the latest messages drop below the
  // visible area and the user has to scroll down to find them.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (prependAnchorRef.current) return;
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
      syncScrollButton(el);
      updateBoundaryMask();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [atBottomRef, scrollRef, syncScrollButton, updateBoundaryMask]);

  // Restore scroll position after older messages have been prepended.
  // useLayoutEffect runs synchronously after DOM mutations but before paint,
  // so the user never sees the intermediate "scrolled to oldest" frame.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = prependAnchorRef.current;
    if (!el || !anchor) return;
    if (loadingMore) return; // wait until the fetch settled
    const delta = el.scrollHeight - anchor.scrollHeight;
    if (delta > 0) {
      el.scrollTop = anchor.scrollTop + delta;
      atBottomRef.current = false;
      setShowScrollButton(hasScrollTarget);
    }
    prependAnchorRef.current = null;
  }, [messages, loadingMore, hasScrollTarget, scrollRef, atBottomRef, setShowScrollButton]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (hasMore && !loadingMore && onLoadMore && el.scrollTop < 60) {
      // Snapshot BEFORE asking the parent to fetch so we can compensate the
      // scroll position once the new (older) messages arrive in props.
      prependAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
      onLoadMore();
    }
    syncScrollButton(el);
    updateBoundaryMask();
    captureBoundaryAnchor(el);
  }

  // Correct for the boundary line relocating when `hotSince` changes
  // (see boundaryAnchorRef above). Re-anchor on the message the user
  // was last scrolled to, rather than on raw scrollHeight — relocating
  // the divider doesn't change total height, so the existing
  // height-delta effects can't catch it.
  const boundaryIdentity = effectiveHotSinceSeq;
  const prevHotSinceRef = useRef<number | null>(boundaryIdentity);
  useLayoutEffect(() => {
    const next = boundaryIdentity;
    const prev = prevHotSinceRef.current;
    prevHotSinceRef.current = next;
    if (prev === next) return;
    const el = scrollRef.current;
    const anchor = boundaryAnchorRef.current;
    if (!el || !anchor || atBottomRef.current || prependAnchorRef.current) return;
    const safeId = anchor.id.replace(/"/g, '\\"');
    const node = el.querySelector(`[data-message-id="${safeId}"]`) as HTMLElement | null;
    if (!node) return;
    const containerTop = el.getBoundingClientRect().top;
    const newTop = node.getBoundingClientRect().top - containerTop;
    el.scrollTop += newTop - anchor.top;
  }, [atBottomRef, boundaryAnchorRef, boundaryIdentity, scrollRef]);

  return { handleScroll };
}

function useTranscriptNavigation({ scrollRef, scrollTargetIntoView, displayMessages, atBottomRef, setShowScrollButton, effectiveHotSinceSeq }: {
  scrollRef: import("react").RefObject<HTMLDivElement | null>;
  scrollTargetIntoView: (target: HTMLElement) => void;
  displayMessages: Message[];
  atBottomRef: import("react").RefObject<boolean>;
  setShowScrollButton: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  effectiveHotSinceSeq: number | null;
}) {
  // Resolve `#msg-<id>` deep links: scroll the matching bubble into view and
  // flash the same highlight ring used by settings deep links. Re-runs when
  // the message list grows (so a fresh-loaded page that contained the target
  // resolves once it's in the DOM) and on every `hashchange` so the same
  // in-thread link can be clicked twice.
  useEffect(() => {
    function scrollToHashTarget() {
      if (typeof window === "undefined") return;
      const hash = window.location.hash;
      if (!hash.startsWith("#msg-")) return;
      const id = decodeURIComponent(hash.slice(5));
      const root = scrollRef.current;
      if (!root) return;
      requestAnimationFrame(() => {
        const safe = id.replace(/"/g, '\\"');
        const el = root.querySelector(`[data-message-id="${safe}"]`) as HTMLElement | null;
        if (!el) return;
        scrollTargetIntoView(el);
        // Strip the hash so the next streaming message / list-length change
        // doesn't yank the view back to this anchor. replaceState avoids
        // triggering a hashchange event (which would re-enter this handler).
        const { pathname, search } = window.location;
        window.history.replaceState(null, "", pathname + search);
      });
    }
    scrollToHashTarget();
    window.addEventListener("hashchange", scrollToHashTarget);
    return () => window.removeEventListener("hashchange", scrollToHashTarget);
  }, [displayMessages.length, scrollRef, scrollTargetIntoView]);

  // Handle orientation changes and resizes to maintain scroll position
  useEffect(() => {
    function handleResize() {
      const el = scrollRef.current;
      if (!el || !atBottomRef.current) return;
      // Re-snap to bottom on resize/orientation change if user was already at bottom
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
    };
  }, [atBottomRef, scrollRef]);

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
    setShowScrollButton(false);
  }

  function scrollToBoundaryLine() {
    const root = scrollRef.current;
    if (!root) return;
    const boundary = effectiveHotSinceSeq !== null
      ? document.getElementById(`context-boundary-${effectiveHotSinceSeq}`)
      : root.querySelector("[data-focus-boundary='1']") as HTMLElement | null;
    if (!boundary) return;
    scrollTargetIntoView(boundary);
  }

  return { scrollToBottom, scrollToBoundaryLine };
}

function MessageFilterControls({
  hasTopControls, topControlsRef, setTopControlsOpen, topControlsOpen,
  topControlsId, compactChat, showDiagnostics, hiddenCount,
  setRevealedForAgent, agentConfig, availableChips, filters,
  toggle, onSetContextPin, scrollToBoundaryLine, hasContextPin,
}: {
  hasTopControls: boolean;
  topControlsRef: import("react").RefObject<HTMLDivElement | null>;
  setTopControlsOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  topControlsOpen: boolean;
  topControlsId: string;
  compactChat: boolean;
  showDiagnostics: boolean;
  hiddenCount: number;
  setRevealedForAgent: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  agentConfig: AgentConfig | null | undefined;
  availableChips: ("scheduled_task" | "watcher" | "bridge" | "extension" | "page_capture" | "synthetic" | "tool_use" | "thinking")[];
  filters: Record<"scheduled_task" | "watcher" | "bridge" | "extension" | "page_capture" | "synthetic" | "tool_use" | "thinking", boolean>;
  toggle: (key: MessageFilterKey) => void;
  onSetContextPin: ((hot_since_seq: number | null) => void) | undefined;
  scrollToBoundaryLine: () => void;
  hasContextPin: boolean;
}) {
  return (<>
    {hasTopControls && (
      <div ref={topControlsRef} className="absolute inset-x-0 top-[calc(var(--app-safe-top)+3rem)] z-30">
        <div className="chat-filter-banner w-full border-b border-border/30 bg-surface/60 backdrop-blur-md">
          <button
            type="button"
            onClick={() => setTopControlsOpen((v) => !v)}
            aria-expanded={topControlsOpen}
            aria-controls={topControlsOpen ? topControlsId : undefined}
            className="workspace-gutter min-h-11 sm:min-h-8 w-full flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-left text-xs text-fg-subtle hover:text-fg transition-colors"
          >
            <CollapseChevron open={topControlsOpen} size={10} />
            <span className="font-medium">Filters & focus</span>
            {compactChat && <span className="text-[11px] text-fg-faint">{showDiagnostics ? "Details on" : "Chat only"}</span>}
            {hiddenCount > 0 && (
              <span className="ml-auto text-[11px] text-fg-faint" aria-live="polite">
                {hiddenCount} hidden
              </span>
            )}
          </button>

          {topControlsOpen && (
            <div
              id={topControlsId}
              role="region"
              aria-label="Message filters and focus"
              className="workspace-gutter grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 max-h-[35dvh] overflow-y-auto overscroll-contain pt-1 pb-2"
            >
              {compactChat && (
                <button
                  type="button"
                  className={`min-h-11 sm:min-h-8 min-w-0 inline-flex items-center justify-center gap-1 rounded-md border px-2 py-1 text-xs leading-4 transition-colors ${showDiagnostics
                    ? "border-accent/40 bg-accent/10 text-fg"
                    : "border-border/60 bg-surface-2/70 text-fg-muted hover:text-fg hover:border-accent/40"
                    }`}
                  aria-pressed={showDiagnostics}
                  aria-label={showDiagnostics ? "Hide technical details" : "Show technical details"}
                  onClick={() => setRevealedForAgent(showDiagnostics ? null : agentConfig?.id ?? null)}
                >
                  {showDiagnostics ? <Eye size={10} /> : <EyeOff size={10} />}
                  Technical details
                </button>
              )}
              {availableChips.filter((key) => showDiagnostics || (key !== "tool_use" && key !== "thinking")).map((key) => {
                const on = filters[key];
                const Icon = on ? Eye : EyeOff;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggle(key)}
                    className={[
                      "min-h-11 sm:min-h-8 min-w-0 inline-flex items-center justify-center gap-1 rounded-md border px-2 py-1 text-xs leading-4 transition-colors",
                      on
                        ? "border-border/70 bg-surface-2/70 text-fg-muted hover:text-fg"
                        : "border-border/35 bg-transparent text-fg-faint line-through decoration-fg-faint/60 hover:text-fg-muted",
                    ].join(" ")}
                    title={
                      // ADR-0044 — for the three channels the model's own
                      // context is scoped by, the chip's meaning is dual:
                      // it doesn't just show/hide rows here, it also
                      // decides whether that channel's history is folded
                      // into the next turn the agent sees.
                      CHANNEL_SCOPED_FILTER_KEYS.has(key)
                        ? (on ? `Hide + exclude ${CHIP_LABELS[key]} from the next turn` : `Show + include ${CHIP_LABELS[key]} in the next turn`)
                        : (on ? `Hide ${CHIP_LABELS[key]} messages` : `Show ${CHIP_LABELS[key]} messages`)
                    }
                    aria-pressed={on}
                  >
                    <Icon size={10} />
                    <span>{CHIP_LABELS[key]}</span>
                  </button>
                );
              })}
              {onSetContextPin && (
                <button
                  type="button"
                  onClick={scrollToBoundaryLine}
                  disabled={!hasContextPin}
                  className="min-h-11 sm:min-h-8 min-w-0 col-span-2 sm:ml-auto rounded-md border border-border/60 bg-surface-2/70 px-2 py-1 text-xs leading-4 text-fg-muted transition-colors hover:border-accent/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border/60 disabled:hover:text-fg-muted"
                  title={hasContextPin ? "Locate the focus boundary in the message list" : "Set a focus boundary first (drag the divider or pin a message) to enable this"}
                >
                  Locate boundary line
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    )}

  </>);
}

function FocusSummaryDialog({
  summaryPopoverOpen, setSummaryPopoverOpen, summaryUpdating, summaryReady,
  summaryStale, summaryFresh, summaryCommittedEmpty, warmChannelSummaries,
  countOlderForHotSince, effectiveHotSinceSeq, hasMore, warmSummary,
  warmSummaryBeforeSeq, warmSummaryComputedAt, streaming, warmSummaryTopics,
}: {
  summaryPopoverOpen: boolean;
  setSummaryPopoverOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  summaryUpdating: boolean;
  summaryReady: boolean;
  summaryStale: boolean;
  summaryFresh: boolean;
  summaryCommittedEmpty: boolean;
  warmChannelSummaries: WarmChannelSummary[];
  countOlderForHotSince: (seq?: number | null) => number;
  effectiveHotSinceSeq: number | null;
  hasMore: boolean | undefined;
  warmSummary: string | null | undefined;
  warmSummaryBeforeSeq: number | null | undefined;
  warmSummaryComputedAt: string | null | undefined;
  streaming: boolean | undefined;
  warmSummaryTopics: SummaryTopicSegment[] | null | undefined;
}) {
  return (<>
    {summaryPopoverOpen && (
      <Dialog
        open
        onClose={() => setSummaryPopoverOpen(false)}
        title="Earlier messages summary"
        size="xl"
        align="top"
        padded={false}
      >
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span
              className={[
                "text-[10px] px-1.5 py-px rounded border inline-flex items-center gap-1",
                summaryUpdating ? "border-accent/40 bg-accent/10 text-accent" :
                  summaryReady ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" :
                    summaryStale ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400" :
                      "border-border bg-surface-2 text-fg-faint",
              ].join(" ")}
            >
              {summaryUpdating && (
                <span className="h-2 w-2 rounded-full bg-accent animate-pulse" aria-label="Summary updating" />
              )}
              <span>
                {summaryUpdating ? "updating" : summaryReady ? "ready" : summaryStale ? "needs refresh" : "pending"}
              </span>
            </span>
          </div>
          {!summaryUpdating && (
            <p className="text-[11px] text-fg-faint">
              {summaryFresh
                ? "Showing the latest summary for messages above the boundary line."
                : summaryCommittedEmpty
                  ? (warmChannelSummaries.length > 0
                    ? "No chat messages above the boundary line; automation activity there is summarised below."
                    : "Nothing above the boundary line needed summarising.")
                  : summaryStale
                    ? "This summary is from an older focus and will refresh after the next reply."
                    : "No summary yet. It will appear after the next reply."}
            </p>
          )}
          <WarmSummaryCard
            olderCount={countOlderForHotSince(effectiveHotSinceSeq) + (hasMore ? 1 : 0)}
            summary={warmSummary ?? null}
            summaryBeforeSeq={warmSummaryBeforeSeq ?? null}
            hotSinceSeq={effectiveHotSinceSeq}
            computedAt={warmSummaryComputedAt ?? null}
            streaming={!!streaming}
            topics={warmSummaryTopics ?? null}
            channelSummaries={warmChannelSummaries}
          />
        </div>
      </Dialog>
    )}

</>);
}

function FocusMoveDialog({
  confirmOpen, setConfirmOpen, setPendingHotSinceSeq, nextHotCount,
  visibleMessages, removesFromRecent, pendingHotSinceSeq, onSetContextPin,
}: {
  confirmOpen: boolean;
  setConfirmOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setPendingHotSinceSeq: import("react").Dispatch<import("react").SetStateAction<number | null>>;
  nextHotCount: number | null;
  visibleMessages: Message[];
  removesFromRecent: boolean;
  pendingHotSinceSeq: number | null;
  onSetContextPin: ((hot_since_seq: number | null) => void) | undefined;
}) {
  return (<>
    <Dialog
      open={confirmOpen}
      onClose={() => { setConfirmOpen(false); setPendingHotSinceSeq(null); }}
      size="sm"
      align="center"
      dismissOnBackdrop={false}
    >
      <h4 className="text-sm font-semibold text-fg">Move conversation focus here?</h4>
      <p className="text-xs text-fg-muted leading-relaxed">
        Start a new conversation context from this point. New replies will prioritize recent messages below this line.
      </p>
      {nextHotCount !== null && (
        <p className="text-[11px] text-fg-faint">
          Recent in focus: {nextHotCount} loaded message{nextHotCount === 1 ? "" : "s"}; earlier loaded summary: {Math.max(0, visibleMessages.length - nextHotCount)}.
        </p>
      )}
      {removesFromRecent && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          This reduces recent in-focus messages. You can drag upward later to add history back.
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={() => { setConfirmOpen(false); setPendingHotSinceSeq(null); }}
          className="px-3 py-1.5 text-xs text-fg-subtle hover:text-fg transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            if (pendingHotSinceSeq !== null && onSetContextPin) onSetContextPin(pendingHotSinceSeq);
            setConfirmOpen(false);
            setPendingHotSinceSeq(null);
          }}
          className="px-3 py-1.5 rounded-md text-xs border border-accent/40 bg-accent text-white hover:opacity-95 transition-opacity"
        >
          Move focus
        </button>
      </div>
    </Dialog>

  </>);
}

function TranscriptEmptyState({ loadingMessages, displayMessages, streamingContent, streaming, visibleMessages, hiddenCount, reset }: {
  loadingMessages: boolean;
  displayMessages: Message[];
  streamingContent: string | undefined;
  streaming: boolean | undefined;
  visibleMessages: Message[];
  hiddenCount: number;
  reset: () => void;
}) {
  return (<>
    {loadingMessages && displayMessages.length === 0 && !streamingContent && !streaming && (
      <div role="status" className="flex items-center justify-center h-full text-fg-faint text-sm select-none">
        Loading conversation…
      </div>
    )}
    {!loadingMessages && visibleMessages.length === 0 && !streamingContent && !streaming && (
      <div className="flex items-center justify-center h-full text-fg-faint text-sm select-none">
        {displayMessages.length === 0 ? (
          <span>Send a message to begin</span>
        ) : (
          <div className="flex flex-col items-center gap-2 text-center px-4">
            <span>{hiddenCount} message{hiddenCount === 1 ? " is" : "s are"} hidden by filters</span>
            <button
              type="button"
              onClick={reset}
              className="control-tap text-xs px-2.5 py-1 rounded-md border border-border bg-surface-2 text-fg-muted hover:text-fg hover:bg-surface-3 transition-colors"
            >
              Show all messages
            </button>
          </div>
        )}
      </div>
    )}

  </>);
}

function FocusedHistoryRows({
  effectiveHotSinceSeq, boundaryIndexFor, visibleMessages, warmSummarySourceMessages,
  warmSummarySourceChars, warmSummary, lineStatsForHotSince, warmSummaryPending,
  summaryFresh, onSetContextPin, isDraggingFocus, streaming,
  handleBoundaryClick, handleBoundaryPointerDown, handleBoundaryPointerMove, handleBoundaryPointerUp,
  handleBoundaryPointerCancel, historyRows,
}: {
  effectiveHotSinceSeq: number | null;
  boundaryIndexFor: (seq?: number | null) => number;
  visibleMessages: Message[];
  warmSummarySourceMessages: number | null | undefined;
  warmSummarySourceChars: number | null | undefined;
  warmSummary: string | null | undefined;
  lineStatsForHotSince: (seq?: number | null) => string;
  warmSummaryPending: boolean;
  summaryFresh: boolean;
  onSetContextPin: ((hot_since_seq: number | null) => void) | undefined;
  isDraggingFocus: boolean;
  streaming: boolean | undefined;
  handleBoundaryClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  handleBoundaryPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
  handleBoundaryPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => void;
  handleBoundaryPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => void;
  handleBoundaryPointerCancel: (e: React.PointerEvent<HTMLButtonElement>) => void;
  historyRows: (import("react").JSX.Element | null)[];
}) {
  return (<>
    {(() => {
      // ADR-0042. The boundary divider + warm summary card live INSIDE the
      // message stream so they scroll with content (not above as a fixed
      // banner). `boundaryIndex` is the index of the first hot message in
      // the visible list; everything before it is older-than-pin and gets
      // covered by the warm summary card sitting above the divider.
      //
      const hasPin = effectiveHotSinceSeq !== null;
      const boundaryIndex = hasPin ? boundaryIndexFor(effectiveHotSinceSeq) : -1;
      const pinAfterAll = hasPin && visibleMessages.length > 0 && boundaryIndex === visibleMessages.length;
      // The pin is the boundary's source of truth. Summary data can arrive
      // later (or be unavailable on an older thread), but hiding the line
      // in that interval makes a valid focus selection look like it vanished.
      const hasBoundary = hasPin && boundaryIndex >= 0;
      const renderBoundary = (key: string) => (
        <div
          key={key}
          id={effectiveHotSinceSeq !== null ? `context-boundary-${effectiveHotSinceSeq}` : undefined}
          data-focus-boundary="1"
          data-boundary-seq={effectiveHotSinceSeq ?? undefined}
        >
          <ContextBoundaryDivider
            sourceMessages={warmSummarySourceMessages ?? null}
            sourceChars={warmSummarySourceChars ?? null}
            summaryChars={warmSummary ? warmSummary.length : null}
            lineStats={lineStatsForHotSince(effectiveHotSinceSeq)}
            updating={warmSummaryPending && !summaryFresh}
            draggable={!!onSetContextPin}
            hidden={isDraggingFocus}
            disabled={!!streaming}
            onClick={handleBoundaryClick}
            onPointerDown={handleBoundaryPointerDown}
            onPointerMove={handleBoundaryPointerMove}
            onPointerUp={handleBoundaryPointerUp}
            onPointerCancel={handleBoundaryPointerCancel}
          />
        </div>
      );

      if (!hasBoundary) return historyRows;
      return [
        ...historyRows.slice(0, boundaryIndex),
        renderBoundary(pinAfterAll ? "boundary-tail" : `boundary-${visibleMessages[boundaryIndex].id}`),
        ...historyRows.slice(boundaryIndex),
      ];
    })()}

  </>);
}

function categoryFilterKey(category: Message["category"]): MessageFilterKey | null {
  switch (category) {
    case "scheduled_task":
    case "watcher":
    case "bridge":
    case "extension":
    case "page_capture":
    case "synthetic":
      return category;
    default:
      return null;
  }
}

function useConversationFocus({
  scrollRef, visibleMessages, effectiveHotSinceSeq, maskRegionRef,
  topControlsRef, bottomOverlayHeight, atBottomRef, hostRef,
  streaming, onSetContextPin, setSummaryPopoverOpen, warmSummary,
  warmSummaryBeforeSeq,
}: {
  scrollRef: import("react").RefObject<HTMLDivElement | null>;
  visibleMessages: Message[];
  effectiveHotSinceSeq: number | null;
  maskRegionRef: import("react").RefObject<HTMLDivElement | null>;
  topControlsRef: import("react").RefObject<HTMLDivElement | null>;
  bottomOverlayHeight: number;
  atBottomRef: import("react").RefObject<boolean>;
  hostRef: import("react").RefObject<HTMLDivElement | null>;
  streaming: boolean | undefined;
  onSetContextPin: ((hot_since_seq: number | null) => void) | undefined;
  setSummaryPopoverOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  warmSummary: string | null | undefined;
  warmSummaryBeforeSeq: number | null | undefined;
}) {
  const { dragPointerIdRef, dragFrameRef, autoScrollFrameRef, autoScrollLockRef, autoScrollVelocityRef, autoScrollPointerYRef, dragYRef, dragStartYRef, dragMovedRef, suppressBoundaryClickRef, dragGuideTopRef, dragGuideRef, dragGuideStatsRef, dragMaskRef, previewHotSinceSeqRef, isDraggingFocus, setIsDraggingFocus, confirmOpen, setConfirmOpen, pendingHotSinceSeq, setPendingHotSinceSeq } = useFocusDragState();

  const { pickHotSinceSeqFromPointerY, boundaryIndexFor, countOlderForHotSince, lineStatsForHotSince, updateBoundaryMask } = useFocusGeometry({ scrollRef, visibleMessages, effectiveHotSinceSeq, dragMaskRef, maskRegionRef });

  const { handleBoundaryPointerDown, handleBoundaryPointerMove, handleBoundaryPointerUp, handleBoundaryPointerCancel, handleBoundaryClick } = useFocusDragging({ dragFrameRef, autoScrollFrameRef, autoScrollLockRef, autoScrollVelocityRef, autoScrollPointerYRef, dragYRef, dragStartYRef, dragMovedRef, dragPointerIdRef, previewHotSinceSeqRef, dragGuideTopRef, setIsDraggingFocus, dragGuideRef, dragGuideStatsRef, updateBoundaryMask, topControlsRef, bottomOverlayHeight, scrollRef, atBottomRef, hostRef, pickHotSinceSeqFromPointerY, lineStatsForHotSince, effectiveHotSinceSeq, setPendingHotSinceSeq, setConfirmOpen, streaming, onSetContextPin, suppressBoundaryClickRef, setSummaryPopoverOpen });

  const currentBoundaryIndex = boundaryIndexFor(effectiveHotSinceSeq);
  const pendingBoundaryIndex = boundaryIndexFor(pendingHotSinceSeq);
  const currentHotCount = currentBoundaryIndex < 0 ? null : visibleMessages.length - currentBoundaryIndex;
  const nextHotCount = pendingBoundaryIndex < 0 ? null : visibleMessages.length - pendingBoundaryIndex;
  const removesFromRecent =
    currentHotCount !== null && nextHotCount !== null
      ? nextHotCount < currentHotCount
      : false;
  const hasWarmSummary = !!warmSummary;
  // A committed boundary whose chat range had nothing to summarise (e.g. a
  // bridge-only agent): the recap, if any, lives in the channel summaries.
  const summaryCommittedEmpty = !hasWarmSummary
    && effectiveHotSinceSeq !== null
    && warmSummaryBeforeSeq === effectiveHotSinceSeq;
  const summaryFresh = hasWarmSummary
    && effectiveHotSinceSeq !== null
    && warmSummaryBeforeSeq === effectiveHotSinceSeq;
  const summaryReady = summaryFresh || summaryCommittedEmpty;
  const summaryUpdating = hasWarmSummary && !summaryFresh && !!streaming;
  const summaryStale = hasWarmSummary && !summaryFresh && !summaryUpdating;

  useEffect(() => {
    requestAnimationFrame(() => updateBoundaryMask());
  }, [isDraggingFocus, updateBoundaryMask]);

  return {
    dragMaskRef,
    updateBoundaryMask,
    boundaryProps: {
      effectiveHotSinceSeq, boundaryIndexFor, lineStatsForHotSince,
      isDraggingFocus, summaryFresh, handleBoundaryClick,
      handleBoundaryPointerDown, handleBoundaryPointerMove,
      handleBoundaryPointerUp, handleBoundaryPointerCancel,
    },
    summaryProps: {
      summaryCommittedEmpty, summaryFresh, summaryReady, summaryUpdating,
      summaryStale, countOlderForHotSince, effectiveHotSinceSeq,
    },
    moveProps: {
      confirmOpen, setConfirmOpen, pendingHotSinceSeq, setPendingHotSinceSeq,
      nextHotCount, visibleMessages, removesFromRecent, onSetContextPin,
    },
    overlayProps: {
      isDraggingFocus, dragGuideRef, dragGuideStatsRef,
      lineStatsForHotSince, effectiveHotSinceSeq,
    },
  };
}

function useMessageControls(hasTopControls: boolean) {
  const topControlsRef = useRef<HTMLDivElement>(null);
  const [topControlsHeight, setTopControlsHeight] = useState(0);
  const [topControlsOpen, setTopControlsOpen] = useState(false);
  const topControlsId = useId();
  useLayoutEffect(() => {
    const controls = topControlsRef.current;
    if (!controls) return;
    const measure = () => setTopControlsHeight(controls.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(controls);
    return () => observer.disconnect();
  }, [hasTopControls]);

  return { hasTopControls, topControlsRef, topControlsHeight, topControlsOpen, setTopControlsOpen, topControlsId };
}

function FocusDragOverlay({ showScrollButton, scrollToBottom, isDraggingFocus, dragGuideRef, dragGuideStatsRef, lineStatsForHotSince, effectiveHotSinceSeq }: {
  showScrollButton: boolean;
  scrollToBottom: () => void;
  isDraggingFocus: boolean;
  dragGuideRef: import("react").RefObject<HTMLDivElement | null>;
  dragGuideStatsRef: import("react").RefObject<HTMLSpanElement | null>;
  lineStatsForHotSince: (seq?: number | null) => string;
  effectiveHotSinceSeq: number | null;
}) {
  return (<>
    {showScrollButton && (
      <button
        onClick={scrollToBottom}
        style={{ bottom: "calc(var(--chat-controls-height) + 1rem)" }}
        className="absolute right-4 p-2 rounded-full bg-accent/40 hover:bg-accent/80 text-white backdrop-blur-sm shadow-md transition-[opacity,transform,background-color] animate-in fade-in slide-in-from-bottom-2 duration-200 z-20"
        title="Auto-scroll paused — resume at latest message"
        aria-label="Resume auto-scroll to latest message"
      >
        <ArrowDown size={18} />
      </button>
    )}

    {isDraggingFocus && (
      <>
        <div ref={dragGuideRef} className="pointer-events-none absolute left-4 right-4 z-50 opacity-0" style={{ transform: "translateY(0px)" }}>
          <div className="h-[2px] bg-gradient-to-r from-transparent via-accent to-transparent opacity-95 shadow-[0_0_8px_rgba(59,130,246,0.55)]" />
          <span
            ref={dragGuideStatsRef}
            className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-fg-faint bg-surface/75 px-1.5 rounded border border-border/60"
          >
            {lineStatsForHotSince(effectiveHotSinceSeq)}
          </span>
        </div>
      </>
    )}

</>);
}

function WarmHistoryMask({ dragMaskRef }: {
  dragMaskRef: import("react").RefObject<HTMLDivElement | null>;
}) {
  return (<>
    <div
      ref={dragMaskRef}
      className="pointer-events-none absolute left-0 right-0 top-0 z-40 opacity-0 transition-opacity duration-75"
      style={{
        transform: "translateY(0px)",
        height: "0px",
        background: "linear-gradient(to top, rgba(82,82,91,0.24) 0%, rgba(82,82,91,0.2) 22%, rgba(82,82,91,0.14) 48%, rgba(82,82,91,0.08) 72%, rgba(82,82,91,0.03) 88%, rgba(82,82,91,0) 100%)",
        borderBottom: "0",
        backdropFilter: "grayscale(0.5) saturate(0.18) contrast(0.98)",
        WebkitBackdropFilter: "grayscale(0.5) saturate(0.18) contrast(0.98)",
        maskImage: "linear-gradient(to top, black 0%, rgba(0,0,0,0.88) 72%, rgba(0,0,0,0.32) 90%, transparent 100%)",
        WebkitMaskImage: "linear-gradient(to top, black 0%, rgba(0,0,0,0.88) 72%, rgba(0,0,0,0.32) 90%, transparent 100%)",
      }}
    />

  </>);
}
