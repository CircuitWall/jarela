"use client";
import { useState } from "react";
import { ChevronRight } from "lucide-react";

export interface ToolEvent {
  id: string;
  phase: "call" | "result";
  name: string;
  payload: unknown;
}

// Above this many events the list collapses to a one-line summary by
// default. Tool-heavy turns (sprint-report skills, multi-step research)
// can otherwise eat half a screen with rows the user rarely re-reads.
const COLLAPSE_THRESHOLD = 3;

// Shared between live-streaming tool events (driven by useSSE) and persisted
// tool events (loaded with each assistant message from /threads/:id). Kept in
// its own file to avoid a circular import between MessageList -> MessageBubble
// when both need to render it.
export function ToolList({ events }: { events: ToolEvent[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(events.length <= COLLAPSE_THRESHOLD);

  if (!expanded) {
    // Compact summary: count + the unique tool names that ran. Clicking
    // the row expands the full event list (calls + results, payloads).
    const uniqueNames = Array.from(new Set(events.map((e) => e.name))).filter(Boolean);
    const callCount = events.filter((e) => e.phase === "call").length;
    const errorCount = events.filter((e) => e.phase === "result" && isErrorPayload(e.payload)).length;
    return (
      <div className="my-1.5 w-full min-w-0 max-w-full overflow-hidden">
        <button
          onClick={() => setExpanded(true)}
          className="w-full min-w-0 flex items-center gap-1.5 text-[11px] hover:bg-surface-2/40 px-1 py-0.5 rounded-md text-left"
        >
          <ChevronRight size={10} className="shrink-0 text-fg-faint" />
          <span className="inline-flex items-center gap-1.5 shrink-0 px-2 py-0.5 rounded-full bg-surface-2/60 border border-border/50 text-fg-muted">
            <span className={`w-1.5 h-1.5 rounded-full ${errorCount > 0 ? "bg-rose-500" : "bg-emerald-500"}`} aria-hidden />
            <span className="font-medium">
              {callCount} tool{callCount === 1 ? "" : "s"}
              {errorCount > 0 && <span className="text-rose-700 dark:text-rose-400/90"> · {errorCount} err</span>}
            </span>
          </span>
          <span className="truncate text-fg-faint font-normal flex-1 min-w-0">
            {uniqueNames.join(" · ")}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="my-1.5 w-full min-w-0 max-w-full overflow-hidden">
      {events.length > COLLAPSE_THRESHOLD && (
        <button
          onClick={() => setExpanded(false)}
          className="w-full min-w-0 flex items-center gap-1.5 text-[11px] hover:bg-surface-2/40 px-1 py-0.5 rounded text-left text-fg-faint"
        >
          <ChevronRight size={10} className="shrink-0 rotate-90 transition-transform" />
          <span className="font-mono uppercase tracking-wide shrink-0">collapse</span>
        </button>
      )}
      {events.map((event, idx) => {
        const key = `${event.id}-${event.phase}-${idx}`;
        const open = openId === key;
        const summary = previewPayload(event.payload);
        const isError = isErrorPayload(event.payload);
        // Phase-colored dot inside each pill: sky=call, emerald=ok, rose=error.
        const dotColor = event.phase === "call"
          ? "bg-sky-500"
          : isError ? "bg-rose-500" : "bg-emerald-500";
        return (
          <div key={key} className="min-w-0 max-w-full">
            <button
              onClick={() => setOpenId(open ? null : key)}
              className="w-full min-w-0 flex items-center gap-1.5 text-[11px] hover:bg-surface-2/40 px-1 py-0.5 rounded-md text-left"
            >
              <ChevronRight size={10} className={`transition-transform shrink-0 ${open ? "rotate-90" : ""} text-fg-faint`} />
              <span className="inline-flex items-center gap-1.5 shrink-0 px-2 py-0.5 rounded-full bg-surface-2/60 border border-border/50 text-fg-muted">
                <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} aria-hidden />
                <span className="font-medium">{event.name}</span>
              </span>
              {!open && <span className="truncate text-fg-faint italic font-normal flex-1 min-w-0">{summary}</span>}
            </button>
            {open && (
              <pre className="ml-5 mt-1 mb-1 px-2 py-1.5 text-[11px] text-fg-muted whitespace-pre font-mono bg-surface/60 rounded-lg border border-border/50 max-w-[calc(100%-1.25rem)] overflow-x-auto">
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
