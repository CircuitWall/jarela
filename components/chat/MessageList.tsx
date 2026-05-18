"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, Clock, X } from "lucide-react";
import type { AgentConfig, Message, UserProfile } from "@/api/types";
import { ToolList, type ToolEvent } from "./ToolList";
import { MessageBubble } from "./MessageBubble";

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

export function MessageList({ messages, notices, agentConfig, userProfile, streamingContent, thinkingContent, toolEvents, hasMore, loadingMore, onLoadMore, queuedMessages, onRemoveQueued }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Tracks whether the user was at the bottom on the most recent scroll event.
  // After every render, if true, we snap to bottom — which means: while the
  // user is at the bottom they "follow" automatically; if they scroll away,
  // they stay where they are; when they scroll back to the bottom they resume
  // following. No timers, no growth checks, no programmatic-scroll guards —
  // the only signal is the user's own scroll position. CSS `overflow-anchor`
  // (browser-default) handles the pagination case (older content prepended
  // keeps visible content stable).
  const atBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
  }); // intentionally no deps — runs after every render

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (hasMore && !loadingMore && onLoadMore && el.scrollTop < 60) onLoadMore();
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  }

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-4">
      {hasMore && (
        <div className="text-center py-1.5 text-[11px] text-fg-faint select-none">
          {loadingMore ? "Loading earlier messages…" : "Scroll up for earlier messages"}
        </div>
      )}
      {messages.length === 0 && !streamingContent && (
        <div className="flex items-center justify-center h-full text-fg-faint text-sm select-none">
          Send a message to begin
        </div>
      )}
      {messages.map((msg, i) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          agentConfig={agentConfig}
          userProfile={userProfile}
          showAvatar={i === 0 || messages[i - 1].role !== msg.role}
        />
      ))}
      {thinkingContent && <ThinkingLine text={thinkingContent} />}
      {toolEvents && toolEvents.length > 0 && <ToolList events={toolEvents} />}
      {streamingContent && (
        <MessageBubble
          message={{ role: "assistant", content: streamingContent, streaming: true }}
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
        </div>
      ))}
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
        className="w-full flex items-center gap-1.5 text-[11px] text-amber-400/70 hover:text-amber-300 px-1 py-0.5"
      >
        <ChevronRight size={10} className={`transition-transform shrink-0 ${open ? "rotate-90" : ""}`} />
        <span className="font-medium">thinking</span>
        {!open && <span className="truncate text-amber-300/40 italic font-normal flex-1 text-left">{tail}</span>}
      </button>
      {open && (
        <pre className="ml-5 mt-1 px-2 py-1.5 text-[11px] text-amber-100/90 whitespace-pre-wrap break-words font-mono bg-amber-950/30 rounded border border-amber-900/30">
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
            className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-surface-3 border border-border text-fg-muted hover:text-rose-400 hover:border-rose-700 hidden group-hover:flex items-center justify-center"
            title="Remove from queue"
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
