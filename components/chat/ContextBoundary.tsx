"use client";
// Inline visual artefacts for ADR-0042: the warm-summary card and the
// context-boundary divider that sits below it. Rendered by MessageList in
// the message stream — between summarised history (above) and the active
// hot context (below). Both stay inside the existing token system
// (accent / surface-2 / fg-* / border) so they read as native chat chrome.

import { useState, type MouseEventHandler, type PointerEventHandler } from "react";
import { Archive, ChevronDown, ChevronUp } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { StatusDot } from "@/components/ui/StatusDot";
import { MetaRow } from "@/components/ui/MetaRow";
import { CollapseChevron } from "@/components/ui/CollapseChevron";
import type { SummaryTopicSegment, WarmChannelSummary } from "@/api/types";

interface WarmSummaryCardProps {
  /** Number of messages older than the boundary that the summary covers. */
  olderCount: number;
  /** Latest persisted summary text, NULL/empty if not yet computed. */
  summary: string | null;
  summaryBeforeSeq?: number | null;
  hotSinceSeq?: number | null;
  /** Wall-clock the summary was computed at; rendered as a relative footer chip. */
  computedAt: string | null;
  /** True while a turn is streaming — promotes the placeholder to a "computing…" state. */
  streaming: boolean;
  /** Per-topic segmentation of the same warm range, if the summarizer returned one. */
  topics?: SummaryTopicSegment[] | null;
  /** Automation-channel recaps (bridge, watcher, scheduled task) at this boundary. */
  channelSummaries?: WarmChannelSummary[];
}

const CHANNEL_LABELS: Record<string, string> = {
  bridge: "Bridge",
  watcher: "Watchers",
  scheduled_task: "Scheduled tasks",
};

export function WarmSummaryCard({
  olderCount,
  summary,
  summaryBeforeSeq,
  hotSinceSeq,
  computedAt,
  streaming,
  topics,
  channelSummaries = [],
}: WarmSummaryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const committed = hotSinceSeq != null && summaryBeforeSeq === hotSinceSeq;
  const fresh = !!summary && committed;
  const stale = !!summary && !fresh;
  const computing = stale && streaming;
  // Summaries stored before topic segmentation still read as topics: their
  // markdown sections render through the same collapsible rows.
  const summaryTopics = summary
    ? (topics && topics.length > 0 ? topics : topicsFromSummarySections(summary))
    : null;

  return (
    <div
      className={[
        "relative my-4 rounded-2xl border bg-gradient-to-br shadow-sm",
        "from-accent/[0.06] via-surface-2 to-surface-2",
        fresh || committed ? "border-accent/30" : "border-border",
      ].join(" ")}
    >
      <div className="flex items-center gap-2 px-4 pt-3 pb-1.5">
        <Archive className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="text-xs font-semibold text-fg">
          Earlier messages summary ({olderCount})
        </span>
        <span className="text-[10px] uppercase tracking-wider px-1.5 py-px rounded text-accent bg-accent/10 border border-accent/20">
          summary memory
        </span>
        <span className="ml-auto text-[10px] text-fg-faint">
          {computedAt ? `Updated ${formatRelative(computedAt)}` : "Not yet generated"}
        </span>
      </div>

      <div className="px-4 pb-3">
        {summaryTopics && (
          <div className="mb-3 flex flex-col gap-1">
            {summaryTopics.map((topic, i) => (
              <TopicSegmentRow key={`${topic.title}-${i}`} topic={topic} />
            ))}
          </div>
        )}
        {!!summary && !summaryTopics ? (
          <div
            className={[
              "prose prose-sm dark:prose-invert max-w-none text-fg-muted",
              "prose-p:my-1.5 prose-headings:mt-2 prose-headings:mb-1",
              expanded ? "" : "line-clamp-6",
            ].join(" ")}
          >
            <ReactMarkdown>{stripWarmHeader(summary!)}</ReactMarkdown>
          </div>
        ) : !summary && committed ? (
          channelSummaries.length === 0 && (
            <div className="text-xs text-fg-faint italic">No earlier chat messages needed summarising.</div>
          )
        ) : !summary ? (
          <div className="flex items-center gap-2 text-xs text-fg-faint italic">
            {computing && (
              <StatusDot tone="accent" size="sm" pulse />
            )}
            <span>
              {computing
                ? "Refreshing earlier summary for this turn..."
                : "Summary will appear after your next reply."}
            </span>
          </div>
        ) : null}

        {channelSummaries.map((channel) => (
          <ChannelSummarySection key={channel.channel} channel={channel} />
        ))}

        {stale && (
          <div className="mt-2 inline-flex items-center gap-2 text-[11px] text-fg-faint">
            {computing ? <StatusDot tone="accent" size="sm" pulse /> : <StatusDot tone="neutral" size="sm" />}
            <span>
              {computing
                ? "Updating summary for your new focus..."
                : "This summary is from an older focus. It updates after your next reply."}
            </span>
          </div>
        )}
      </div>

      {fresh && !summaryTopics && summaryLong(summary!) && (
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

function ChannelSummarySection({ channel }: { channel: WarmChannelSummary }) {
  const topics = channel.topics && channel.topics.length > 0
    ? channel.topics
    : topicsFromSummarySections(channel.summary)
      ?? [{ title: "Recap", start_at: "", end_at: "", recap: stripWarmHeader(channel.summary), facts: [] }];
  return (
    <div className="mt-2">
      <div className="mb-1 text-[9px] uppercase tracking-wide text-fg-faint">
        {CHANNEL_LABELS[channel.channel] ?? channel.channel}
      </div>
      <div className="flex flex-col gap-1">
        {topics.map((topic, i) => (
          <TopicSegmentRow key={`${channel.channel}-${topic.title}-${i}`} topic={topic} />
        ))}
      </div>
    </div>
  );
}

function TopicSegmentRow({ topic }: { topic: SummaryTopicSegment }) {
  const [open, setOpen] = useState(false);
  const range = formatTopicRange(topic.start_at, topic.end_at);
  return (
    <div className="min-w-0">
      <MetaRow fullWidth onClick={() => setOpen((v) => !v)} expanded={open} accent="neutral">
        <CollapseChevron open={open} size={9} />
        <span className="font-medium text-fg-muted truncate">{topic.title}</span>
        {range && <span className="text-fg-faint shrink-0">· {range}</span>}
        {typeof topic.message_count === "number" && topic.message_count > 0 && (
          <span className="text-fg-faint shrink-0">
            · {topic.message_count} {topic.message_count === 1 ? "msg" : "msgs"}
          </span>
        )}
        {topic.facts.length > 0 && (
          <span className="ml-auto shrink-0 text-[9px] uppercase tracking-wide text-accent">
            {topic.facts.length} memorized
          </span>
        )}
      </MetaRow>
      {!open && topic.recap && (
        <div className="mt-1 ml-4 text-[11px] text-fg-muted line-clamp-2">
          <ReactMarkdown>{topic.recap}</ReactMarkdown>
        </div>
      )}
      {open && (
        <div className="mt-1 ml-4 space-y-1.5">
          {topic.recap && (
            <div className="text-[11px] text-fg-muted">
              <ReactMarkdown>{topic.recap}</ReactMarkdown>
            </div>
          )}
          {topic.facts.length > 0 && (
            <div>
              <div className="text-[9px] uppercase tracking-wide text-fg-faint">Memorized</div>
              <ul className="space-y-0.5">
                {topic.facts.map((fact, i) => (
                  <li key={`${fact.key ?? fact.subject}-${i}`} className="text-[11px] text-fg-faint">
                    <span className="font-medium text-fg-muted">{fact.subject}:</span> {fact.content}
                    {fact.key && <code className="ml-1 text-[10px] text-fg-faint">{fact.key}</code>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatTopicRange(startAt: string, endAt: string): string | null {
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const fmt: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const startLabel = start.toLocaleDateString(undefined, fmt);
  const endLabel = end.toLocaleDateString(undefined, fmt);
  return startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`;
}

interface ContextBoundaryDividerProps {
  // Stats for the chip readout: how many messages went into the warm
  // summary, the size of their flattened transcript, and the size of the
  // resulting summary. All three are NULL on threads whose summary
  // predates the stat columns — the chip falls back to just the label.
  sourceMessages?: number | null;
  sourceChars?: number | null;
  summaryChars?: number | null;
  draggable?: boolean;
  disabled?: boolean;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  onPointerMove?: PointerEventHandler<HTMLButtonElement>;
  onPointerUp?: PointerEventHandler<HTMLButtonElement>;
  onPointerCancel?: PointerEventHandler<HTMLButtonElement>;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  ariaLabel?: string;
  hidden?: boolean;
  updating?: boolean;
  lineStats?: string | null;
}

export function ContextBoundaryDivider({
  sourceMessages,
  sourceChars,
  summaryChars,
  draggable = false,
  disabled = false,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onClick,
  ariaLabel = "Drag to move conversation focus",
  hidden = false,
  updating = false,
  lineStats = null,
}: ContextBoundaryDividerProps = {}) {
  const hasStats =
    typeof sourceMessages === "number" && sourceMessages > 0 &&
    typeof sourceChars === "number" && sourceChars > 0;
  const ratio = hasStats && typeof summaryChars === "number" && summaryChars > 0 && sourceChars! > 0
    ? Math.max(0, Math.round((1 - summaryChars / sourceChars!) * 100))
    : null;

  const tooltip = hasStats
    ? `Compacted ${sourceMessages} message${sourceMessages === 1 ? "" : "s"} (${sourceChars!.toLocaleString()} chars) into ${typeof summaryChars === "number" ? `${summaryChars.toLocaleString()} chars` : "memory"}`
    : undefined;

  if (draggable) {
    return (
      <div
        className={[
          "relative my-3 select-none transition-opacity",
          hidden ? "opacity-0" : "opacity-100",
        ].join(" ")}
        aria-label="conversation focus boundary"
      >
        <button
          type="button"
          className={[
            "group relative block h-7 w-full touch-none",
            disabled ? "cursor-not-allowed opacity-60" : "cursor-grab active:cursor-grabbing",
          ].join(" ")}
          title={tooltip}
          aria-label={ariaLabel}
          disabled={disabled}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onClick={onClick}
        >
          <span className={["absolute inset-x-0 top-1/2 -translate-y-1/2 border-t border-dashed group-hover:border-accent/70", updating ? "border-accent/70" : "border-accent/40"].join(" ")} aria-hidden />
          <span
            className={["absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 bg-gradient-to-r from-transparent via-accent/90 to-transparent shadow-[0_0_8px_rgba(59,130,246,0.55)] group-hover:opacity-100", updating ? "opacity-80 animate-pulse" : "opacity-95"].join(" ")}
            aria-hidden
          />
          {lineStats && (
            <span
              className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-fg-faint bg-surface/75 px-1.5 rounded border border-border/60"
              aria-hidden
            >
              {lineStats}
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="relative my-3 select-none" aria-label="conversation focus boundary">
      {onClick && (
        <button
          type="button"
          className="absolute inset-x-0 top-1/2 h-7 -translate-y-1/2"
          aria-label={ariaLabel}
          onClick={onClick}
        />
      )}
      <div className="absolute inset-0 flex items-center" aria-hidden>
        <div className="relative w-full">
          <div className={["w-full border-t border-dashed", updating ? "border-accent/70" : "border-accent/40"].join(" ")} />
          <div className={["absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 bg-gradient-to-r from-transparent via-accent/85 to-transparent shadow-[0_0_8px_rgba(59,130,246,0.5)]", updating ? "opacity-80 animate-pulse" : "opacity-95"].join(" ")} />
        </div>
      </div>
      <div className="relative flex justify-end pr-1">
        {(lineStats || hasStats) && (
          <span className="text-[10px] text-fg-faint bg-surface/75 px-1.5 rounded" title={tooltip}>
            {lineStats ?? (
              <>
                {sourceMessages} msg · {formatBytes(sourceChars!)}
                {typeof summaryChars === "number" && summaryChars > 0 && (
                  <>
                    {" → "}
                    {formatBytes(summaryChars)}
                    {ratio !== null && ratio > 0 && ` (−${ratio}%)`}
                  </>
                )}
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

// Compact character-count formatter: 4321 → "4.3k", 18234 → "18k".
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return `${n}`;
  const k = n / 1000;
  return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, "")}k`;
}

// `buildWarmSummary` prepends a couple of plain-text header lines that read
// awkwardly inside a card that already has its own header. Strip them.
function stripWarmHeader(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/^\s*(<!--[\s\S]*?-->\s*)+/, "")
    .replace(/^--- Warm context summary ---\n/, "")
    .replace(/^Compressed recap of [^\n]*:\n/, "")
    .trimStart();
}

/**
 * Splits a markdown summary into topic segments at its headings. Returns
 * null when there are fewer than two sections, so short or unstructured
 * summaries keep the plain prose rendering.
 */
export function topicsFromSummarySections(raw: string): SummaryTopicSegment[] | null {
  const sections: SummaryTopicSegment[] = [];
  let title: string | null = null;
  let body: string[] = [];
  const flush = () => {
    const recap = body.join("\n").trim();
    if (title !== null || recap) sections.push({ title: title ?? "Overview", start_at: "", end_at: "", recap, facts: [] });
  };
  for (const line of stripWarmHeader(raw).split("\n")) {
    const heading = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      title = heading[1];
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return sections.length >= 2 ? sections : null;
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
