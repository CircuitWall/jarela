"use client";
import { useState } from "react";
import { ChevronRight } from "lucide-react";

export interface ToolEvent {
  id: string;
  phase: "call" | "result";
  name: string;
  payload: unknown;
}

// Shared between live-streaming tool events (driven by useSSE) and persisted
// tool events (loaded with each assistant message from /threads/:id). Kept in
// its own file to avoid a circular import between MessageList -> MessageBubble
// when both need to render it.
export function ToolList({ events }: { events: ToolEvent[] }) {
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
