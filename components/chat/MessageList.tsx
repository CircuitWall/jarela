"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Clock, X, ArrowDown, Eye, EyeOff } from "lucide-react";
import type { AgentConfig, Message, UserProfile } from "@/api/types";
import { ToolList, type ToolEvent } from "./ToolList";
import { MessageBubble } from "./MessageBubble";
import { useMessageFilters, MESSAGE_FILTER_KEYS, type MessageFilterKey } from "@/hooks/useMessageFilters";

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
}

export function MessageList({ threadId, messages, notices, agentConfig, userProfile, streamingContent, thinkingContent, toolEvents, hasMore, loadingMore, onLoadMore, queuedMessages, onRemoveQueued }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { filters, toggle } = useMessageFilters();

  // Apply category filter. Messages with no `category` (NULL = ordinary
  // chat) are always shown; tagged messages are gated by their toggle.
  // The `tool_use` and `thinking` filters do NOT remove whole messages —
  // they're handled below by gating the inline ToolList / ThinkingLine.
  const visibleMessages = useMemo(() => {
    return messages.filter((m) => {
      const cat = m.category;
      if (!cat) return true;
      if (cat === "scheduled_task") return filters.scheduled_task;
      if (cat === "bridge") return filters.bridge;
      if (cat === "synthetic") return filters.synthetic;
      // Unknown future categories: show by default so forward-compat clients
      // never silently drop content the server thinks should be visible.
      return true;
    });
  }, [messages, filters.scheduled_task, filters.bridge, filters.synthetic]);

  const hiddenCount = messages.length - visibleMessages.length;

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
      else if (m.category === "bridge") set.add("bridge");
      else if (m.category === "synthetic") set.add("synthetic");
      if (m.tool_events && m.tool_events.length > 0) set.add("tool_use");
    }
    if (thinkingContent) set.add("thinking");
    if (toolEvents && toolEvents.length > 0) set.add("tool_use");
    return MESSAGE_FILTER_KEYS.filter((k) => set.has(k));
  }, [messages, thinkingContent, toolEvents]);
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

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
  }); // intentionally no deps — runs after every render

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (hasMore && !loadingMore && onLoadMore && el.scrollTop < 60) onLoadMore();
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
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-4"
      style={{
        // Fade the top and bottom 24px of the scroll viewport so messages
        // dissolve under the glass chrome instead of slamming into a hard
        // edge. Vendor-prefixed for older WebKit (Safari < 15.4).
        WebkitMaskImage:
          "linear-gradient(180deg, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%)",
        maskImage:
          "linear-gradient(180deg, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%)",
      }}
    >
      {hasMore && (
        <div className="text-center py-1.5 text-[11px] text-fg-faint select-none">
          {loadingMore ? "Loading earlier messages…" : "Scroll up for earlier messages"}
        </div>
      )}
      {availableChips.length > 0 && (
        <FilterToolbar
          chips={availableChips}
          filters={filters}
          onToggle={toggle}
          hiddenCount={hiddenCount}
        />
      )}
      {messages.length === 0 && !streamingContent && (
        <div className="flex items-center justify-center h-full text-fg-faint text-sm select-none">
          Send a message to begin
        </div>
      )}
      {visibleMessages.map((msg, i) => {
        const startsTurn = i === 0 || visibleMessages[i - 1].role !== msg.role;
        return (
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
            />
          </div>
        );
      })}
      {thinkingContent && filters.thinking && <ThinkingLine text={thinkingContent} />}
      {toolEvents && toolEvents.length > 0 && filters.tool_use && <ToolList events={toolEvents} />}
      {streamingContent && (
        <MessageBubble
          message={{ role: "assistant", content: streamingContent, streaming: true }}
          threadId={threadId ?? null}
          agentConfig={agentConfig}
          showAvatar={messages.length === 0 || messages[messages.length - 1].role !== "assistant"}
        />
      )}
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
              {showScrollButton && (
                <button
                  onClick={scrollToBottom}
                  className="fixed bottom-20 right-6 p-2.5 rounded-full bg-accent hover:bg-accent-hover text-white shadow-lg transition-all animate-in fade-in slide-in-from-bottom-2 duration-200 z-30"
                  title="Scroll to latest message"
                  aria-label="Scroll to latest message"
                >
                  <ArrowDown size={18} />
                </button>
              )}
        </div>
      ))}
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
  bridge: "bridge",
  synthetic: "captures",
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
    <div className="sticky top-0 z-10 -mx-4 px-4 py-1.5 mb-2 flex items-center gap-1.5 flex-wrap bg-surface/80 backdrop-blur border-b border-border/40 text-[11px]">
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
        <ChevronRight size={10} className={`transition-transform shrink-0 ${open ? "rotate-90" : ""}`} />
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
