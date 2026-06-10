"use client";
// Inline visual artefacts for ADR-0042: the warm-summary card and the
// context-boundary divider that sits below it. Rendered by MessageList in
// the message stream — between summarised history (above) and the active
// hot context (below). Both stay inside the existing token system
// (accent / surface-2 / fg-* / border) so they read as native chat chrome.

import { useState } from "react";
import { Archive, ChevronDown, ChevronUp } from "lucide-react";
import ReactMarkdown from "react-markdown";

interface WarmSummaryCardProps {
  /** Number of messages older than the boundary that the summary covers. */
  olderCount: number;
  /** Latest persisted summary text, NULL/empty if not yet computed. */
  summary: string | null;
  /** ISO timestamp the cached summary covers; compared to `hotSince` to know freshness. */
  summaryBefore: string | null;
  /** Pin position. When this differs from `summaryBefore`, the card shows a placeholder. */
  hotSince: string | null;
  /** Wall-clock the summary was computed at; rendered as a relative footer chip. */
  computedAt: string | null;
  /** True while a turn is streaming — promotes the placeholder to a "computing…" state. */
  streaming: boolean;
}

export function WarmSummaryCard({
  olderCount,
  summary,
  summaryBefore,
  hotSince,
  computedAt,
  streaming,
}: WarmSummaryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const fresh = !!summary && summaryBefore === hotSince;
  const computing = !fresh && streaming;

  return (
    <div
      className={[
        "relative my-4 rounded-2xl border bg-gradient-to-br shadow-sm",
        "from-accent/[0.06] via-surface-2 to-surface-2",
        fresh ? "border-accent/30" : "border-border",
      ].join(" ")}
    >
      <div className="flex items-center gap-2 px-4 pt-3 pb-1.5">
        <Archive className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="text-xs font-semibold text-fg">
          Summary of {olderCount} earlier message{olderCount === 1 ? "" : "s"}
        </span>
        <span className="text-[10px] uppercase tracking-wider px-1.5 py-px rounded text-accent bg-accent/10 border border-accent/20">
          warm context
        </span>
        <span className="ml-auto text-[10px] text-fg-faint">
          {computedAt ? `Generated ${formatRelative(computedAt)}` : "Not yet computed"}
        </span>
      </div>

      <div className="px-4 pb-3">
        {fresh ? (
          <div
            className={[
              "prose prose-sm dark:prose-invert max-w-none text-fg-muted",
              "prose-p:my-1.5 prose-headings:mt-2 prose-headings:mb-1",
              expanded ? "" : "line-clamp-6",
            ].join(" ")}
          >
            <ReactMarkdown>{stripWarmHeader(summary!)}</ReactMarkdown>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-fg-faint italic">
            {computing && (
              <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse" aria-hidden />
            )}
            <span>
              {computing
                ? "Re-summarising older context for this turn…"
                : "Summary will appear after your next reply."}
            </span>
          </div>
        )}
      </div>

      {fresh && summaryLong(summary!) && (
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          className="absolute right-3 bottom-2 inline-flex items-center gap-1 text-[10px] text-fg-faint hover:text-fg-muted transition-colors"
        >
          {expanded ? (<><ChevronUp className="w-3 h-3" /> Show less</>)
                    : (<><ChevronDown className="w-3 h-3" /> Show more</>)}
        </button>
      )}
    </div>
  );
}

interface ContextBoundaryDividerProps {
  // Reserved for future variations of the divider (e.g. compact mode).
  // Kept as an empty object so MessageList's call site stays stable.
  className?: string;
}

export function ContextBoundaryDivider(_props: ContextBoundaryDividerProps = {}) {
  return (
    <div className="relative my-3 select-none" aria-label="context boundary">
      <div className="absolute inset-0 flex items-center" aria-hidden>
        <div className="w-full border-t border-dashed border-accent/40" />
      </div>
      <div className="relative flex justify-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-medium uppercase tracking-wider bg-surface border border-accent/40 text-accent shadow-sm">
          <span>Context boundary</span>
        </div>
      </div>
    </div>
  );
}

// `buildWarmSummary` prepends a couple of plain-text header lines that read
// awkwardly inside a card that already has its own header. Strip them.
function stripWarmHeader(raw: string): string {
  return raw
    .replace(/^--- Warm context summary ---\n/, "")
    .replace(/^Compressed recap of earlier messages outside the hot window:\n/, "")
    .trimStart();
}

function summaryLong(raw: string): boolean {
  // Heuristic: more than 6 lines or > 600 chars after the header strip.
  const stripped = stripWarmHeader(raw);
  return stripped.length > 600 || stripped.split("\n").length > 6;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (!Number.isFinite(diff) || diff < 0) return "";
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
