"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { AgentConfig, Message, UserProfile } from "@/api/types";
import type { ToolEvent } from "@/hooks/useSSE";
import { MessageBubble } from "./MessageBubble";

interface SystemNotice {
  id: string;
  text: string;
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
}

export function MessageList({ messages, notices, agentConfig, userProfile, streamingContent, thinkingContent, toolEvents, hasMore, loadingMore, onLoadMore }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevFirstId = useRef<string | null>(null);
  const prevScrollHeight = useRef<number>(0);

  // "Following" the bottom: latched by user scroll, NOT by transient distance.
  //   - Starts true.
  //   - User scrolls > 200px above bottom → flips false (we stop yanking them).
  //   - User scrolls back within 80px of bottom → flips true (resumes follow).
  // Computing "near bottom" per-effect was unreliable: as content streams in,
  // scrollHeight grows but the just-set scrollTop hasn't, so the check flipped
  // false mid-stream and auto-scroll silently quit before the message ended.
  const followingRef = useRef(true);
  // After we programmatically scroll, the next scroll event is ours, not the
  // user's — ignore it so we don't immediately latch following=false on long
  // tables that overshoot during smooth scroll.
  const programmaticScrollAt = useRef(0);

  function scrollToBottom(smooth: boolean) {
    const el = scrollRef.current;
    if (!el) return;
    programmaticScrollAt.current = Date.now();
    if (smooth) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    else el.scrollTop = el.scrollHeight;
  }

  // Streaming chunks fire many times/sec — use instant scroll to keep up.
  // For new messages (less frequent), smooth feels nicer.
  //
  // Only scroll when content actually GREW. Without this, any unrelated
  // re-render of an ancestor (clicking the gear, dispatch in a context, etc.)
  // would re-fire this effect with the same dep values and yank the chat
  // back to the bottom. Tracking a "last seen" snapshot in a ref lets us
  // distinguish genuine growth from "just re-running the effect".
  const lastSeen = useRef({ msgs: 0, stream: 0, think: 0, tools: 0 });
  useEffect(() => {
    const cur = {
      msgs: messages.length,
      stream: streamingContent?.length ?? 0,
      think: thinkingContent?.length ?? 0,
      tools: toolEvents?.length ?? 0,
    };
    const grew =
      cur.msgs > lastSeen.current.msgs ||
      cur.stream > lastSeen.current.stream ||
      cur.think > lastSeen.current.think ||
      cur.tools > lastSeen.current.tools;
    lastSeen.current = cur;
    if (!grew || !followingRef.current) return;
    scrollToBottom(!streamingContent);
  }, [messages.length, streamingContent, thinkingContent, toolEvents?.length]);

  // Preserve scroll position when older messages are prepended.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const firstId = messages[0]?.id ?? null;
    if (prevFirstId.current && firstId !== prevFirstId.current && prevScrollHeight.current) {
      el.scrollTop = el.scrollHeight - prevScrollHeight.current;
    }
    prevFirstId.current = firstId;
    prevScrollHeight.current = el.scrollHeight;
  }, [messages]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    // Pagination: load older when scrolled to the top.
    if (hasMore && !loadingMore && onLoadMore && el.scrollTop < 60) onLoadMore();

    // Skip latching for the brief window after a programmatic scroll — those
    // events are our own and shouldn't be interpreted as user intent.
    if (Date.now() - programmaticScrollAt.current < 350) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > 200) {
      followingRef.current = false;
    } else if (distanceFromBottom < 80) {
      followingRef.current = true;
    }
  }

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-4">
      {hasMore && (
        <div className="text-center py-1.5 text-[11px] text-zinc-500 select-none">
          {loadingMore ? "Loading earlier messages…" : "Scroll up for earlier messages"}
        </div>
      )}
      {messages.length === 0 && !streamingContent && (
        <div className="flex items-center justify-center h-full text-zinc-500 text-sm select-none">
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
      {notices?.map((n) => (
        <div key={n.id} className="flex justify-center my-3">
          <span className="text-xs italic text-zinc-500 bg-surface-2 px-3 py-1 rounded-full border border-border">
            {n.text}
          </span>
        </div>
      ))}
      <div ref={bottomRef} />
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

function ToolList({ events }: { events: ToolEvent[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="my-1.5">
      {events.map((event, idx) => {
        const key = `${event.id}-${event.phase}-${idx}`;
        const open = openId === key;
        const summary = previewPayload(event.payload);
        const isError = isErrorPayload(event.payload);
        const verbColor = event.phase === "call"
          ? "text-sky-400/70"
          : isError ? "text-rose-400/80" : "text-emerald-400/70";
        return (
          <div key={key}>
            <button
              onClick={() => setOpenId(open ? null : key)}
              className="w-full flex items-center gap-1.5 text-[11px] hover:bg-zinc-800/40 px-1 py-0.5 rounded text-left"
            >
              <ChevronRight size={10} className={`transition-transform shrink-0 ${open ? "rotate-90" : ""} text-zinc-500`} />
              <span className={`font-mono uppercase tracking-wide ${verbColor}`}>{event.phase}</span>
              <span className="font-medium text-zinc-300">{event.name}</span>
              {!open && <span className="truncate text-zinc-500 italic font-normal flex-1">{summary}</span>}
            </button>
            {open && (
              <pre className="ml-5 mt-1 mb-1 px-2 py-1.5 text-[11px] text-zinc-300 whitespace-pre-wrap break-words font-mono bg-zinc-900/60 rounded border border-zinc-800">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function previewPayload(payload: unknown): string {
  try {
    const s = typeof payload === "string" ? payload : JSON.stringify(payload);
    const oneLine = s.replace(/\s+/g, " ");
    return oneLine.length > 80 ? oneLine.slice(0, 80) + "…" : oneLine;
  } catch {
    return "";
  }
}

function isErrorPayload(payload: unknown): boolean {
  if (typeof payload === "string") return /error/i.test(payload);
  if (payload && typeof payload === "object" && "error" in payload) return true;
  return false;
}
