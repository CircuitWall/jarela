"use client";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Clock, X, ArrowDown, Eye, EyeOff } from "lucide-react";
import type { AgentConfig, ContentPart, Message, UserProfile } from "@/api/types";
import { ToolList, type ToolEvent } from "./ToolList";
import { MessageBubble } from "./MessageBubble";
import { ContextBoundaryDivider, WarmSummaryCard } from "./ContextBoundary";
import { useMessageFilters, MESSAGE_FILTER_KEYS, type MessageFilterKey } from "@/hooks/useMessageFilters";
import { CollapseChevron } from "@/components/ui/CollapseChevron";

interface SystemNotice {
  id: string;
  text: string;
}

interface QueuedMessageView {
  id: string;
  text: string;
  attachmentCount: number;
}

interface Props {
  threadId?: string | null;
  messages: Message[];
  notices?: SystemNotice[];
  agentConfig?: AgentConfig | null;
  userProfile?: UserProfile | null;
  streamingContent?: string;
  thinkingContent?: string;
  toolEvents?: ToolEvent[];
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  queuedMessages?: QueuedMessageView[];
  onRemoveQueued?: (id: string) => void;
  // ADR-0042 — explicit context boundary state. The boundary divider is
  // rendered in the message stream right after the last message older than
  // `hotSince` (or above the first loaded message when the pin sits earlier
  // than the visible window). The warm-summary card sits directly above
  // the divider and shows the latest persisted recap.
  hotSince?: string | null;
  warmSummary?: string | null;
  warmSummaryBefore?: string | null;
  warmSummaryComputedAt?: string | null;
  warmSummarySourceMessages?: number | null;
  warmSummarySourceChars?: number | null;
  onSetContextPin?: (hot_since: string | null) => void;
  streaming?: boolean;
  // Thread-level context window cap, forwarded to each MessageBubble so
  // the ContextUsageBar has a baseline for rows whose own usage snapshot
  // predates the per-row column.
  contextWindowTokens?: number | null;
  // Resend a previously-sent user prompt as a new turn. Forwarded to each
  // user-role MessageBubble; absent => retry button is hidden.
  onRetryMessage?: (text: string, attachments: ContentPart[]) => void;
}

export function MessageList({ threadId, messages, notices, agentConfig, userProfile, streamingContent, thinkingContent, toolEvents, hasMore, loadingMore, onLoadMore, queuedMessages, onRemoveQueued, hotSince, warmSummary, warmSummaryBefore, warmSummaryComputedAt, warmSummarySourceMessages, warmSummarySourceChars, onSetContextPin, streaming, contextWindowTokens, onRetryMessage }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { filters, toggle, reset } = useMessageFilters(agentConfig?.id ?? null);
  const autoRecoveredRef = useRef<string | null>(null);

  // Apply category filter. Messages with no `category` (NULL = ordinary
  // chat) are always shown; tagged messages are gated by their toggle.
  // The `tool_use` and `thinking` filters do NOT remove whole messages —
  // they're handled below by gating the inline ToolList / ThinkingLine.
  const visibleMessages = useMemo(() => {
    return messages.filter((m) => {
      const cat = m.category;
      if (!cat) return true;
      if (cat === "scheduled_task") return filters.scheduled_task;
      if (cat === "watcher") return filters.watcher;
      if (cat === "bridge") return filters.bridge;
      if (cat === "extension") return filters.extension;
      if (cat === "page_capture") return filters.page_capture;
      if (cat === "synthetic") return filters.synthetic;
      // Unknown future categories: show by default so forward-compat clients
      // never silently drop content the server thinks should be visible.
      return true;
    });
  }, [messages, filters.scheduled_task, filters.watcher, filters.bridge, filters.extension, filters.page_capture, filters.synthetic]);

  const hiddenCount = messages.length - visibleMessages.length;

  // Self-heal stale/accidental filter states that blank an entire thread.
  // If a thread has persisted messages but every one is filtered out, users
  // perceive this as "chat is empty". Auto-reset once per thread snapshot so
  // content remains visible without requiring manual recovery.
  useEffect(() => {
    if (messages.length === 0 || streamingContent) return;
    if (visibleMessages.length > 0) return;
    if (hiddenCount !== messages.length) return;
    const lastId = messages[messages.length - 1]?.id ?? "none";
    const key = `${threadId ?? "no-thread"}:${messages.length}:${lastId}`;
    if (autoRecoveredRef.current === key) return;
    autoRecoveredRef.current = key;
    reset();
  }, [threadId, messages, visibleMessages.length, hiddenCount, streamingContent, reset]);

  // Surface a category chip in the toolbar only if it can actually do
  // something useful right now: scheduled_task/bridge/synthetic chips
  // appear only when at least one such message exists in the loaded
  // transcript; tool_use appears when any assistant message has tool
  // events; thinking appears when there's live thinking content (the
  // only place it currently surfaces).
  const availableChips = useMemo(() => {
    const set = new Set<MessageFilterKey>();
    for (const m of messages) {
      if (m.category === "scheduled_task") set.add("scheduled_task");
      else if (m.category === "watcher") set.add("watcher");
      else if (m.category === "bridge") set.add("bridge");
      else if (m.category === "extension") set.add("extension");
      else if (m.category === "page_capture") set.add("page_capture");
      else if (m.category === "synthetic") set.add("synthetic");
      if (m.tool_events && m.tool_events.length > 0) set.add("tool_use");
    }
    if (thinkingContent) set.add("thinking");
    if (toolEvents && toolEvents.length > 0) set.add("tool_use");
    return MESSAGE_FILTER_KEYS.filter((k) => set.has(k));
  }, [messages, thinkingContent, toolEvents]);
  // Count of tool_call ids that haven't been matched by a tool_result yet.
  // Drives the streaming-bubble's CountdownRing pause so the wall-clock
  // indicator matches the run-registry's effective-elapsed semantics
  // (tool execution time is excluded from the agent's budget).
  const inflightToolCount = useMemo(() => {
    if (!toolEvents || toolEvents.length === 0) return 0;
    const open = new Set<string>();
    for (const ev of toolEvents) {
      if (ev.phase === "call") open.add(ev.id);
      else if (ev.phase === "result") open.delete(ev.id);
    }
    return open.size;
  }, [toolEvents]);
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
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
  }); // intentionally no deps — runs after every render

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
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
    }
    prependAnchorRef.current = null;
  }, [messages, loadingMore]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (hasMore && !loadingMore && onLoadMore && el.scrollTop < 60) {
      // Snapshot BEFORE asking the parent to fetch so we can compensate the
      // scroll position once the new (older) messages arrive in props.
      prependAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
      onLoadMore();
    }
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    atBottomRef.current = isAtBottom;
    setShowScrollButton(!isAtBottom && messages.length > 0);
  }

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
        atBottomRef.current = false;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("jarela-deep-link-flash");
        setTimeout(() => el.classList.remove("jarela-deep-link-flash"), 1600);
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
  }, [messages.length]);

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
  }, []);

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
    setShowScrollButton(false);
  }

  // The filter toolbar uses `position: fixed` (anchored just below the
  // fixed AppShell header) so iOS PWA rubberband-bounce and any layout
  // shift in the surrounding flex column can't pull it under the header
  // and strand it there. We mirror its actual rendered height into a
  // shrink-0 spacer in the flex column so the scroll viewport doesn't
  // slide underneath — ResizeObserver because the chip row can wrap to
  // two lines on narrow viewports with many active categories.
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarH, setToolbarH] = useState(0);
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) { setToolbarH(0); return; }
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? 0;
      setToolbarH(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [availableChips.length]);

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      {/* Fixed-positioned toolbar pinned right below the AppShell header.
          A shrink-0 spacer below reserves its vertical space in the flex
          column so the message viewport doesn't slide under it. */}
      {availableChips.length > 0 && (
        <>
          <div
            ref={toolbarRef}
            className="fixed left-0 right-0 z-30"
            style={{ top: "calc(3rem + var(--app-safe-top))" }}
          >
            <FilterToolbar
              chips={availableChips}
              filters={filters}
              onToggle={toggle}
              hiddenCount={hiddenCount}
            />
          </div>
          <div className="shrink-0" aria-hidden style={{ height: toolbarH }} />
        </>
      )}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-4 panel-scrollbar"
        style={{
          // Scroll-anchor jumps (deep-link to a message) land below the
          // floating header, not under it.
          scrollPaddingTop: "calc(3rem + var(--app-safe-top))",
        }}
      >
        {hasMore && (
          <div className="text-center py-1.5 text-[11px] text-fg-faint select-none">
            {loadingMore ? "Loading earlier messages…" : "Scroll up for earlier messages"}
          </div>
        )}
        {visibleMessages.length === 0 && !streamingContent && (
          <div className="flex items-center justify-center h-full text-fg-faint text-sm select-none">
            {messages.length === 0 ? (
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
      {(() => {
        // ADR-0042. The boundary divider + warm summary card live INSIDE the
        // message stream so they scroll with content (not above as a fixed
        // banner). `boundaryIndex` is the index of the first hot message in
        // the visible list; everything before it is older-than-pin and gets
        // covered by the warm summary card sitting above the divider.
        //
        // If `hotSince` sits strictly after every loaded message (the
        // post-/compact "/new" state), every visible message is warm and
        // the boundary is rendered AFTER the last bubble.
        const boundaryIndex = hotSince
          ? visibleMessages.findIndex((m) => m.created_at >= hotSince)
          : -1;
        const pinAfterAll =
          !!hotSince && visibleMessages.length > 0 && boundaryIndex === -1
          && visibleMessages[visibleMessages.length - 1].created_at < hotSince;
        const hasBoundary = !!hotSince && (boundaryIndex !== -1 || pinAfterAll);
        const olderInVisible = pinAfterAll
          ? visibleMessages.length
          : hasBoundary ? boundaryIndex : 0;
        // "+ N more we don't know about yet" — older pages are likely unloaded.
        const olderCountLabel = olderInVisible + (hasMore ? 1 : 0);

        const renderBoundary = (key: string) => (
          <div key={key}>
            <WarmSummaryCard
              olderCount={olderCountLabel}
              summary={warmSummary ?? null}
              summaryBefore={warmSummaryBefore ?? null}
              hotSince={hotSince ?? null}
              computedAt={warmSummaryComputedAt ?? null}
              streaming={!!streaming}
            />
            <ContextBoundaryDivider
              sourceMessages={warmSummarySourceMessages ?? null}
              sourceChars={warmSummarySourceChars ?? null}
              summaryChars={warmSummary ? warmSummary.length : null}
            />
          </div>
        );

        const nodes = visibleMessages.flatMap((msg, i) => {
          const startsTurn = i === 0 || visibleMessages[i - 1].role !== msg.role;
          const out = [] as React.ReactNode[];
          if (hasBoundary && !pinAfterAll && i === boundaryIndex) {
            out.push(renderBoundary(`boundary-${msg.id}`));
          }
          out.push(
            <div
              key={msg.id}
              id={`msg-${msg.id}`}
              data-message-id={msg.id}
              className={startsTurn && i > 0 ? "mt-3" : undefined}
            >
              <MessageBubble
                message={msg}
                threadId={threadId ?? null}
                agentConfig={agentConfig}
                userProfile={userProfile}
                showAvatar={startsTurn}
                showToolEvents={filters.tool_use}
                contextWindowTokens={contextWindowTokens ?? null}
                isLatest={i === visibleMessages.length - 1 && !streamingContent}
                onRetry={onRetryMessage}
              />
            </div>,
          );
          return out;
        });
        if (pinAfterAll) nodes.push(renderBoundary("boundary-tail"));
        return nodes;
      })()}
      {thinkingContent && filters.thinking && <ThinkingLine text={thinkingContent} />}
      {streamingContent && (
        <StreamingBubble
          content={streamingContent}
          threadId={threadId ?? null}
          agentConfig={agentConfig ?? null}
          showAvatar={messages.length === 0 || messages[messages.length - 1].role !== "assistant"}
          inflightToolCount={inflightToolCount}
        />
      )}
      {toolEvents && toolEvents.length > 0 && filters.tool_use && <ToolList events={toolEvents} />}
      {queuedMessages && queuedMessages.length > 0 && (
        <div className="flex flex-col gap-1 mt-2 mb-1">
          {queuedMessages.map((q) => (
            <QueuedBubble key={q.id} item={q} onRemove={onRemoveQueued} />
          ))}
        </div>
      )}
      {notices?.map((n) => (
        <div key={n.id} className="flex justify-center my-3">
          <span className="text-xs italic text-fg-faint bg-surface-2 px-3 py-1 rounded-full border border-border">
            {n.text}
          </span>
        </div>
      ))}
      </div>
      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          style={{ top: `calc(3rem + var(--app-safe-top) + ${toolbarH}px + 0.75rem)` }}
          className="absolute left-1/2 -translate-x-1/2 p-2 rounded-full bg-accent/40 hover:bg-accent/80 text-white backdrop-blur-sm shadow-md transition-all animate-in fade-in slide-in-from-top-2 duration-200 z-20"
          title="Scroll to latest message"
          aria-label="Scroll to latest message"
        >
          <ArrowDown size={18} />
        </button>
      )}
    </div>
  );
}

// Compact horizontal toolbar of category-visibility chips. Only renders
// chips whose category is currently represented in the visible transcript,
// so the toolbar stays empty for plain user/assistant threads. Hidden
// counter on the right tells the user how many messages are gated out by
// the current filter so the absence isn't mysterious.
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
function FilterToolbar({
  chips,
  filters,
  onToggle,
  hiddenCount,
}: {
  chips: readonly MessageFilterKey[];
  filters: Record<MessageFilterKey, boolean>;
  onToggle: (key: MessageFilterKey) => void;
  hiddenCount: number;
}) {
  return (
    <div className="px-4 py-1.5 flex items-center gap-1.5 flex-wrap bg-surface/80 backdrop-blur border-b border-border/40 text-[11px]">
      <span className="text-fg-faint mr-0.5 select-none">show:</span>
      {chips.map((key) => {
        const on = filters[key];
        const Icon = on ? Eye : EyeOff;
        return (
          <button
            key={key}
            onClick={() => onToggle(key)}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border transition-colors ${
              on
                ? "bg-surface-2 border-border text-fg-muted hover:text-fg"
                : "bg-transparent border-border/40 text-fg-faint hover:text-fg-muted line-through decoration-fg-faint/60"
            }`}
            title={on ? `Hide ${CHIP_LABELS[key]} messages` : `Show ${CHIP_LABELS[key]} messages`}
            aria-pressed={on}
          >
            <Icon size={10} />
            <span>{CHIP_LABELS[key]}</span>
          </button>
        );
      })}
      {hiddenCount > 0 && (
        <span className="ml-auto text-fg-faint select-none" aria-live="polite">
          {hiddenCount} hidden
        </span>
      )}
    </div>
  );
}

// Streaming-bubble wrapper. Wraps the in-flight assistant bubble so the
// `message` object passed to MessageBubble keeps a stable identity across
// renders that don't actually change the streaming text — without this
// the inline `{ role, content, streaming: true }` literal in the parent
// JSX would defeat MessageBubble's React.memo on every parent re-render.
const StreamingBubble = memo(function StreamingBubble({
  content,
  threadId,
  agentConfig,
  showAvatar,
  inflightToolCount,
}: {
  content: string;
  threadId: string | null;
  agentConfig: AgentConfig | null;
  showAvatar: boolean;
  inflightToolCount: number;
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
      inflightToolCount={inflightToolCount}
    />
  );
});

function ThinkingLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, " ").trim();
  const tail = preview.length > 60 ? preview.slice(-60) : preview;
  return (
    <div className="my-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-400/70 hover:text-amber-700 dark:hover:text-amber-300 px-1 py-0.5"
      >
        <CollapseChevron open={open} size={10} />
        <span className="font-medium">thinking</span>
        {!open && <span className="truncate text-amber-700 dark:text-amber-300/40 italic font-normal flex-1 text-left">{tail}</span>}
      </button>
      {open && (
        <pre className="ml-5 mt-1 px-2 py-1.5 text-[11px] text-amber-900 dark:text-amber-100/90 whitespace-pre-wrap break-words font-mono bg-amber-100/60 dark:bg-amber-950/30 rounded border border-amber-300 dark:border-amber-900/30">
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
          <Clock size={10} />
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
