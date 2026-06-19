"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, X, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { CollapseChevron } from "@/components/ui/CollapseChevron";

export interface ToolEvent {
  id: string;
  phase: "call" | "result";
  name: string;
  payload: unknown;
}

// Default per-tool wallclock budget (mirrors lib/tools/wallclock.ts).
// Used as the progress-bar denominator when the agent didn't set
// `deadline_ms` on the call.
const DEFAULT_DEADLINE_MS = 120_000;

// Wrapper-injected schema fields that should not appear in the user-facing
// "command/usage" summary — they're transport plumbing, not arguments
// the operator cares about glancing at.
const HIDDEN_ARG_KEYS = new Set(["deadline_ms", "async_run"]);

// Above this many grouped tool calls, the per-call cards collapse into a
// single summary line ("local_exec(2) web_search(5)") that the user can
// click to expand. Below it, cards render directly so a small batch is
// glanceable without an extra click.
const COLLAPSE_THRESHOLD = 3;

// Shared between live-streaming tool events (driven by useSSE) and persisted
// tool events (loaded with each assistant message from /threads/:id). One
// card per call id; a parallel batch naturally renders as a stack of cards
// with simultaneous progress bars.
export function ToolList({ events }: { events: ToolEvent[] }) {
  const groups = useMemo(() => groupByCallId(events), [events]);
  // Remember the first wall-clock instant each call id was observed so the
  // progress bar resumes correctly across re-renders and the start time
  // survives parent re-mounts within the same stream.
  const startedAtRef = useRef<Map<string, number>>(new Map());
  for (const g of groups) {
    if (!startedAtRef.current.has(g.id)) startedAtRef.current.set(g.id, Date.now());
  }
  const [expanded, setExpanded] = useState(false);
  if (groups.length === 0) return null;
  // Below the threshold we always render the cards (a small batch is
  // glanceable). At or above it we collapse into a one-line summary that
  // updates live; the user can click to expand into the full per-call
  // card view.
  const showCards = expanded || groups.length <= COLLAPSE_THRESHOLD;
  if (!showCards) {
    return (
      <div className="my-1.5 w-full min-w-0 max-w-full">
        <CollapsedSummary groups={groups} onExpand={() => setExpanded(true)} />
      </div>
    );
  }
  return (
    <div className="my-1.5 w-full min-w-0 max-w-full flex flex-col gap-1">
      {groups.length > COLLAPSE_THRESHOLD && (
        <button
          onClick={() => setExpanded(false)}
          className="self-start text-[10px] uppercase tracking-wide text-fg-faint hover:text-fg-muted px-1"
        >
          collapse
        </button>
      )}
      {groups.map((g) => (
        <ToolCallCard
          key={g.id}
          group={g}
          startedAt={startedAtRef.current.get(g.id) ?? Date.now()}
        />
      ))}
    </div>
  );
}

function CollapsedSummary({
  groups,
  onExpand,
}: {
  groups: ToolCallGroup[];
  onExpand: () => void;
}) {
  // Bucket by tool name. For each bucket we keep count + running totals
  // for the live ticker. Visible bucket count caps at TOP_BUCKETS; the
  // rest collapse into `+N more` so very large batches stay one line.
  const TOP_BUCKETS = 3;
  const order: string[] = [];
  const byName = new Map<string, { count: number; running: number }>();
  for (const g of groups) {
    const slot = byName.get(g.name);
    if (slot) {
      slot.count += 1;
      if (g.status === "running" || g.status === "async") slot.running += 1;
    } else {
      byName.set(g.name, {
        count: 1,
        running: g.status === "running" || g.status === "async" ? 1 : 0,
      });
      order.push(g.name);
    }
  }
  // Sort buckets by count desc, breaking ties by first-seen order so the
  // most active tool floats to the left.
  const orderIdx = new Map(order.map((n, i) => [n, i] as const));
  const ranked = order.slice().sort((a, b) => {
    const ca = byName.get(a)!.count;
    const cb = byName.get(b)!.count;
    if (cb !== ca) return cb - ca;
    return (orderIdx.get(a)! - orderIdx.get(b)!);
  });
  const visible = ranked.slice(0, TOP_BUCKETS);
  const hiddenCount = ranked.length - visible.length;
  return (
    <button
      onClick={onExpand}
      className="w-full min-w-0 flex items-center gap-2 px-2 py-1 text-[11px] text-left rounded-md border border-border/50 bg-surface-2/60 hover:bg-surface-3/50 transition-colors"
      aria-label={`expand ${groups.length} tool calls`}
    >
      <ChevronRight size={10} className="shrink-0 text-fg-faint" />
      <Wrench size={11} className="shrink-0 text-fg-faint" aria-hidden />
      <span className="truncate flex-1 min-w-0 text-fg-muted">
        {visible.map((name, i) => {
          const slot = byName.get(name)!;
          const countLabel =
            slot.running > 0
              ? `${slot.count - slot.running}/${slot.count}`
              : slot.count > 1
              ? `×${slot.count}`
              : null;
          return (
            <span key={name}>
              {i > 0 && <span className="text-fg-faint"> · </span>}
              <span className="font-medium">{name}</span>
              {countLabel && (
                <span className="text-fg-faint"> {countLabel}</span>
              )}
            </span>
          );
        })}
        {hiddenCount > 0 && (
          <span className="text-fg-faint"> · +{hiddenCount} more</span>
        )}
      </span>
    </button>
  );
}

interface ToolCallGroup {
  id: string;
  name: string;
  args: unknown;
  result: unknown;
  deadlineMs: number;
  status: "running" | "ok" | "error" | "async";
  // True when this group's `result` arrived via a later tool_result_get
  // call rather than the original tool's direct return. Surfaces a small
  // "read" pill so it's obvious the agent reaped a background handoff.
  readByAgent: boolean;
  // Internal — set on tool_result_get groups that got absorbed into the
  // matching async handoff card. Skipped during render.
  absorbed: boolean;
}

function groupByCallId(events: ToolEvent[]): ToolCallGroup[] {
  const order: string[] = [];
  const map = new Map<string, ToolCallGroup>();
  for (const ev of events) {
    let g = map.get(ev.id);
    if (!g) {
      g = {
        id: ev.id,
        name: ev.name,
        args: undefined,
        result: undefined,
        deadlineMs: DEFAULT_DEADLINE_MS,
        status: "running",
        readByAgent: false,
        absorbed: false,
      };
      map.set(ev.id, g);
      order.push(ev.id);
    }
    if (!g.name && ev.name) g.name = ev.name;
    if (ev.phase === "call") {
      g.args = unwrapLangChainSerializable(ev.payload);
      const d = readDeadlineMs(g.args);
      if (d) g.deadlineMs = d;
    } else {
      const payload = unwrapLangChainSerializable(ev.payload);
      g.result = payload;
      if (isErrorPayload(payload)) g.status = "error";
      else if (isAsyncHandoffPayload(payload)) g.status = "async";
      else g.status = "ok";
    }
  }

  // Second pass: merge `tool_result_get` calls into their target async
  // handoff so the UI shows a single card per logical operation
  // ("local_exec ... $ echo ABC ... [read][✓]") instead of one card for
  // the handoff and a second card for the reaper.
  const byAsyncKey = new Map<string, ToolCallGroup>();
  for (const g of map.values()) {
    if (g.status === "async") {
      const k = readAsyncKey(g.result);
      if (k) byAsyncKey.set(k, g);
    }
  }
  for (const g of map.values()) {
    if (g.name !== "tool_result_get") continue;
    // Prefer the args key (available even while the call is pending),
    // but fall back to the RESULT key. The reaper result always echoes
    // `key` and `tool` (see `serialize` in lib/tools/async-results-tool.ts),
    // so even when the LLM stream lost the args mid-flight we can still
    // pair the reaper to its handoff after it finishes.
    const targetKey = readKeyArg(g.args) ?? readKeyFromReaperResult(g.result);
    if (!targetKey) continue;
    const target = byAsyncKey.get(targetKey);
    if (!target) continue;
    target.readByAgent = true;
    // If the original handoff card lost its tool name (the model emitted
    // it but the streaming chunk dropped it), pick it up from the
    // reaper's result for a friendlier label.
    if (!target.name || target.name === "") {
      const inferred = readToolFromReaperResult(g.result);
      if (inferred) target.name = inferred;
    }
    // Only adopt the reaped payload after it actually arrived; while the
    // tool_result_get call is in-flight the target stays in "async".
    if (g.status !== "running") {
      const unwrapped = unwrapReaperResult(g.result);
      if (unwrapped.kind === "done") {
        // The inner result coming back from the wallclock async store is
        // a *stringified* `ToolMessage` (lib/tools/wallclock.ts persists
        // `JSON.stringify(result)` and tool.invoke now returns a
        // ToolMessage object, not a raw string). Unwrap that second
        // layer so KV / args extractors see the actual tool output.
        const inner = unwrapLangChainSerializable(unwrapped.value);
        target.result = inner;
        target.status = isErrorPayload(inner) ? "error" : "ok";
      } else if (unwrapped.kind === "error") {
        target.result = unwrapLangChainSerializable(unwrapped.value);
        target.status = "error";
      }
      // "pending" or "unknown" — leave target as async; just mark read.
    }
    g.absorbed = true;
  }

  return order.map((id) => map.get(id)!).filter((g) => !g.absorbed);
}

function ToolCallCard({ group, startedAt }: { group: ToolCallGroup; startedAt: number }) {
  const [open, setOpen] = useState(false);
  const effectiveArgs = hasVisibleArgs(group.args)
    ? group.args
    : argsFromResult(group.name, group.result);
  const summary = renderArgsSummary(group.name, effectiveArgs);
  const summaryTitle = argsSummaryTitle(group.name, effectiveArgs);
  const hasArgs = hasVisibleArgs(effectiveArgs);
  return (
    <div className="min-w-0 max-w-full rounded-md border border-border/50 bg-surface-2/60 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full min-w-0 flex items-center gap-2 px-2 py-1 text-[11px] text-left hover:bg-surface-3/50 transition-colors"
        aria-expanded={open}
      >
        <CollapseChevron open={open} size={10} className="text-fg-faint" />
        <Wrench size={11} className="shrink-0 text-fg-faint" aria-hidden />
        <span className="font-medium text-fg-muted shrink-0">{group.name}</span>
        <span
          className="relative truncate text-fg-faint font-normal flex-1 min-w-0"
          title={summaryTitle || undefined}
          style={{
            // Fade the tail of the args summary into the surface so the
            // status pills + progress bar on the right stay legible even
            // when the args fill the available space.
            WebkitMaskImage:
              "linear-gradient(to right, black 0, black calc(100% - 28px), transparent 100%)",
            maskImage:
              "linear-gradient(to right, black 0, black calc(100% - 28px), transparent 100%)",
          }}
        >
          {summary}
        </span>
        {group.status === "async" && (
          <Badge
            tone="info"
            className="uppercase tracking-wide"
            title="running in the background"
          >
            bg
          </Badge>
        )}
        {group.readByAgent && (
          <Badge
            tone="neutral"
            className="uppercase tracking-wide"
            title="agent read the background result"
          >
            read
          </Badge>
        )}
        <StatusIndicator
          status={group.status}
          deadlineMs={group.deadlineMs}
          startedAt={startedAt}
        />
      </button>
      {open && (
        <div className="border-t border-border/40 bg-surface/60 px-2 py-1.5 space-y-1.5">
          {hasVisibleArgs(group.args) ? (
            <DetailSection label="arguments" value={group.args} />
          ) : hasArgs ? (
            <DetailSection
              label="arguments (inferred from result)"
              value={effectiveArgs}
            />
          ) : null}
          {group.status !== "running" && group.status !== "async" && (
            <DetailSection
              label={group.status === "error" ? "error" : "result"}
              value={group.result}
              tone={group.status === "error" ? "error" : "default"}
            />
          )}
          {group.status === "async" && (
            <DetailSection
              label="background handoff"
              value={group.result}
            />
          )}
        </div>
      )}
    </div>
  );
}

function StatusIndicator({
  status,
  deadlineMs,
  startedAt,
}: {
  status: "running" | "ok" | "error" | "async";
  deadlineMs: number;
  startedAt: number;
}) {
  if (status === "ok") {
    return (
      <span className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" aria-label="succeeded">
        <Check size={11} strokeWidth={3} />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-rose-500/15 text-rose-600 dark:text-rose-400" aria-label="failed">
        <X size={11} strokeWidth={3} />
      </span>
    );
  }
  // "running" (sync) and "async" (background) are both still in-flight from
  // the user's perspective \u2014 a wallclock progress bar reads the same.
  // The card-level `bg` pill differentiates them.
  return <ProgressBar deadlineMs={deadlineMs} startedAt={startedAt} />;
}

function ProgressBar({ deadlineMs, startedAt }: { deadlineMs: number; startedAt: number }) {
  const fillRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (typeof requestAnimationFrame === "undefined") return;
    let raf = 0;
    const denom = Math.max(1, deadlineMs);
    const tick = () => {
      const node = fillRef.current;
      if (node) {
        const elapsed = Math.max(0, Date.now() - startedAt);
        // Perceptual curve: most tool calls finish in well under 1% of
        // their wall-clock budget (a 200ms local op against the 120s
        // default would otherwise paint 0.16% and look frozen). A
        // sqrt curve gives short calls visible movement (200ms → ~4%,
        // 1s → ~9%, 4s → ~18%) while still pinning at 100% when the
        // budget is actually exhausted.
        const linear = Math.min(1, elapsed / denom);
        const pct = Math.sqrt(linear);
        node.style.width = `${(pct * 100).toFixed(2)}%`;
        if (linear >= 1) return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [deadlineMs, startedAt]);
  return (
    <span
      className="shrink-0 w-16 h-1 rounded-full bg-surface-3 overflow-hidden"
      role="progressbar"
      aria-label={`tool running, budget ${Math.round(deadlineMs / 1000)}s`}
    >
      <div
        ref={fillRef}
        className="h-full bg-sky-500/80 transition-[width] duration-75 ease-linear"
        style={{ width: "0%" }}
      />
    </span>
  );
}

function DetailSection({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: unknown;
  tone?: "default" | "error";
}) {
  const toneClass =
    tone === "error"
      ? "text-rose-700 dark:text-rose-300/90"
      : "text-fg-muted";
  // Object payloads (args, structured results) render as a compact KV
  // table so the operator can scan field-by-field; only fall back to the
  // JSON pre-block when the value can't be expressed that way (strings
  // that aren't JSON, arrays, primitives).
  const kvEntries = toKvEntries(value);
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-fg-faint mb-0.5">{label}</div>
      {kvEntries ? (
        <dl className={`grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px] font-mono ${toneClass}`}>
          {kvEntries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-fg-faint">{k}</dt>
              <dd className="min-w-0 break-words whitespace-pre-wrap">{renderKvValue(v)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <pre className={`text-[11px] font-mono whitespace-pre-wrap break-words max-w-full ${toneClass}`}>
          {formatPayload(value)}
        </pre>
      )}
    </div>
  );
}

// Coerce a payload into [key, value] entries when it sensibly maps to a
// KV table. Returns null for arrays, primitives, and strings that aren't
// JSON — those render via the JSON pre-block fallback.
function toKvEntries(value: unknown): Array<[string, unknown]> | null {
  const obj = coerceObject(value);
  if (!obj) return null;
  const entries = Object.entries(obj).filter(([k]) => !HIDDEN_ARG_KEYS.has(k));
  return entries.length > 0 ? entries : null;
}

function formatKvValue(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

const URL_RE = /^https?:\/\/[^\s]+$/i;

// Render a KV value as a ReactNode with type-aware affordances rather
// than dumping JSON. Handles the shapes that actually appear in tool
// results — URLs become clickable, search-result arrays render as a
// titled link list with snippet, primitive arrays join with commas,
// nested objects render as an indented mini-grid, generic arrays of
// objects collapse to a count to keep the panel scannable.
function renderKvValue(v: unknown): ReactNode {
  if (v == null) return <span className="text-fg-faint">{String(v)}</span>;
  if (typeof v === "string") {
    if (URL_RE.test(v)) {
      return (
        <a
          href={v}
          target="_blank"
          rel="noreferrer noopener"
          className="text-sky-500 hover:underline break-all"
        >
          {v}
        </a>
      );
    }
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);

  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="text-fg-faint">[]</span>;

    // Search-result shape: each item has at least { title, url }.
    if (v.every(isSearchResultLike)) {
      return (
        <ol className="space-y-1 list-decimal list-inside marker:text-fg-faint">
          {v.map((item, i) => {
            const it = item as { title: unknown; url: unknown; snippet?: unknown };
            const title = typeof it.title === "string" && it.title.trim().length > 0
              ? it.title
              : String(it.url);
            const url = typeof it.url === "string" ? it.url : null;
            const snippet = typeof it.snippet === "string" ? it.snippet.trim() : "";
            return (
              <li key={i} className="min-w-0">
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-sky-500 hover:underline break-words"
                  >
                    {title}
                  </a>
                ) : (
                  <span>{title}</span>
                )}
                {snippet && (
                  <div className="text-fg-faint break-words whitespace-pre-wrap">{snippet}</div>
                )}
              </li>
            );
          })}
        </ol>
      );
    }

    // Primitive arrays: comma-joined inline.
    if (v.every((it) => it == null || typeof it !== "object")) {
      return v.map((it) => (it == null ? String(it) : String(it))).join(", ");
    }

    // Generic array of objects: render each as a nested mini-grid with
    // a tiny "1.", "2." prefix so they stay individually scannable.
    return (
      <ol className="space-y-1 list-decimal list-inside marker:text-fg-faint">
        {v.map((it, i) => (
          <li key={i} className="min-w-0">{renderKvValue(it)}</li>
        ))}
      </ol>
    );
  }

  // Nested object: indented mini-grid.
  const obj = coerceObject(v);
  if (obj) {
    const entries = Object.entries(obj).filter(([k]) => !HIDDEN_ARG_KEYS.has(k));
    if (entries.length === 0) return <span className="text-fg-faint">{"{}"}</span>;
    return (
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
        {entries.map(([k, vv]) => (
          <div key={k} className="contents">
            <dt className="text-fg-faint">{k}</dt>
            <dd className="min-w-0 break-words whitespace-pre-wrap">{renderKvValue(vv)}</dd>
          </div>
        ))}
      </dl>
    );
  }

  return formatKvValue(v);
}

function isSearchResultLike(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const o = item as Record<string, unknown>;
  return typeof o.url === "string" && (typeof o.title === "string" || typeof o.name === "string");
}

// Tools whose primary argument is a literal shell command line. Their
// summary reads better as a prompt-style snippet than as `command: "..."`.
const SHELL_TOOL_NAMES = new Set(["local_exec", "shell_exec"]);

// Per-tool well-known primary argument. When present, the per-card
// summary renders just the quoted value (e.g. `web_search "world news
// 2026-06-14"`) instead of `key: value` pairs.
const PRIMARY_ARG_KEYS = ["query", "q", "url", "path", "text", "title", "key"];

// When the LLM stream drops the original args mid-flight (a real upstream
// quirk on parallel tool batches), recover what we can from the tool's
// own result — most tools echo their primary argument back. e.g.
// `web_search` returns `{ query, ... }`; `web_fetch` returns `{ url, ... }`.
function argsFromResult(toolName: string, result: unknown): Record<string, unknown> | null {
  const obj = coerceObject(result);
  if (!obj) return null;
  const out: Record<string, unknown> = {};
  // Prefer well-known echoed argument names. Keep the list small — these
  // must be values the tool itself populated, not arbitrary result keys
  // that happen to share a name.
  for (const key of ["query", "q", "url", "command", "path", "text"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) out[key] = v;
    else if (typeof v === "number") out[key] = v;
  }
  // Shell tools sometimes only have `cwd`; surface it if no command echoed.
  if (SHELL_TOOL_NAMES.has(toolName) && !out.command) {
    const cwd = obj.cwd;
    if (typeof cwd === "string" && cwd.length > 0) out.cwd = cwd;
  }
  return Object.keys(out).length > 0 ? out : null;
}


// Render the per-card header summary as a ReactNode so the primary arg
// is the protagonist (no `key=` prefix, no surrounding quotes; shell
// commands in mono with a faint `$`) and secondary args fade into faint
// `· key=value` chips. The matching plain-text `argsSummaryTitle` feeds
// the native tooltip so hovering still reveals the unstyled form.
function renderArgsSummary(toolName: string, args: unknown): ReactNode {
  if (args == null) return null;
  if (typeof args === "string") {
    return <span className="italic">{truncate(args.replace(/\s+/g, " "), 80)}</span>;
  }
  if (typeof args !== "object") return <span>{truncate(String(args), 80)}</span>;
  const record = args as Record<string, unknown>;
  if (SHELL_TOOL_NAMES.has(toolName) && typeof record.command === "string") {
    return (
      <span className="font-mono text-fg-muted">
        <span className="text-fg-faint">$</span>{" "}
        {truncate(record.command.replace(/\s+/g, " "), 78)}
      </span>
    );
  }
  const entries = Object.entries(record).filter(
    ([k]) => !HIDDEN_ARG_KEYS.has(k),
  );
  if (entries.length === 0) return null;
  entries.sort(([a], [b]) => primaryRank(a) - primaryRank(b));
  const [primaryKey, primaryValue] = entries[0];
  const rest = entries.slice(1);
  const isPrimaryKnown = primaryRank(primaryKey) < PRIMARY_ARG_KEYS.length;
  const primaryNode = isPrimaryKnown
    ? renderPrimaryValue(primaryKey, primaryValue)
    : <span className="font-mono">{primaryKey}={formatScalar(primaryValue)}</span>;
  return (
    <span className="inline-flex items-baseline gap-1.5 min-w-0 max-w-full">
      <span className="truncate min-w-0">{primaryNode}</span>
      {rest.length > 0 && (
        <span className="shrink-0 text-fg-faint/70 font-mono">
          {rest.map(([k, v], i) => (
            <span key={k}>
              {i > 0 ? " " : " · "}
              {k}={formatScalar(v)}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

function renderPrimaryValue(key: string, value: unknown): ReactNode {
  if (typeof value === "string") {
    const s = value.replace(/\s+/g, " ").trim();
    if (key === "url" && URL_RE.test(s)) {
      // Strip the scheme to give more room without losing the URL cue.
      const stripped = s.replace(/^https?:\/\//i, "");
      return <span className="font-mono">{truncate(stripped, 78)}</span>;
    }
    if (key === "path") {
      return <span className="font-mono">{truncate(s, 78)}</span>;
    }
    if (key === "key") {
      return <span className="font-mono">{truncate(s, 32)}</span>;
    }
    // query / q / text / title — natural language, italicised, no quotes.
    return <span className="italic">{truncate(s, 78)}</span>;
  }
  return <span className="font-mono">{formatScalar(value)}</span>;
}

function argsSummaryTitle(toolName: string, args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  if (typeof args !== "object") return String(args);
  const record = args as Record<string, unknown>;
  if (SHELL_TOOL_NAMES.has(toolName) && typeof record.command === "string") {
    return `$ ${record.command}`;
  }
  const entries = Object.entries(record).filter(
    ([k]) => !HIDDEN_ARG_KEYS.has(k),
  );
  if (entries.length === 0) return "";
  entries.sort(([a], [b]) => primaryRank(a) - primaryRank(b));
  return entries.map(([k, v]) => `${k}=${formatScalar(v)}`).join(" ");
}

function primaryRank(key: string): number {
  const idx = PRIMARY_ARG_KEYS.indexOf(key);
  return idx === -1 ? PRIMARY_ARG_KEYS.length : idx;
}

function hasVisibleArgs(args: unknown): boolean {
  if (args == null) return false;
  if (typeof args === "string") return args.trim().length > 0;
  if (typeof args !== "object") return true;
  return Object.keys(args as Record<string, unknown>).some(
    (k) => !HIDDEN_ARG_KEYS.has(k),
  );
}

function formatScalar(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === "string") {
    const s = v.replace(/\s+/g, " ");
    return s.length > 40 ? `"${s.slice(0, 40)}…"` : `"${s}"`;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 40 ? `${s.slice(0, 40)}…` : s;
  } catch {
    return "…";
  }
}

function formatPayload(payload: unknown): string {
  if (payload == null) return String(payload);
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function readDeadlineMs(args: unknown): number | null {
  if (!args || typeof args !== "object") return null;
  const raw = (args as Record<string, unknown>).deadline_ms;
  if (typeof raw === "number" && raw > 0 && Number.isFinite(raw)) return raw;
  return null;
}

function isErrorPayload(payload: unknown): boolean {
  if (typeof payload === "string") {
    if (/^\s*{/.test(payload)) {
      try {
        return isErrorPayload(JSON.parse(payload));
      } catch {
        // fall through to substring check
      }
    }
    return /\b(error|failed|exception)\b/i.test(payload);
  }
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (p.ok === false) return true;
    if (typeof p.error === "string" || typeof p.error_code === "string") return true;
  }
  return false;
}

// Wallclock async-run handoff: `{ ok: true, async: true, key, tool, ... }`.
// Result is just the bookkeeping pointer; the real work is still running.
function isAsyncHandoffPayload(payload: unknown): boolean {
  const obj = coerceObject(payload);
  return !!obj && obj.ok === true && obj.async === true && typeof obj.key === "string";
}

function readAsyncKey(payload: unknown): string | null {
  const obj = coerceObject(payload);
  if (obj && typeof obj.key === "string" && obj.async === true) return obj.key;
  return null;
}

function readKeyArg(args: unknown): string | null {
  if (args && typeof args === "object") {
    const v = (args as Record<string, unknown>).key;
    if (typeof v === "string") return v;
  }
  return null;
}

function readKeyFromReaperResult(payload: unknown): string | null {
  const obj = coerceObject(payload);
  if (obj && typeof obj.key === "string") return obj.key;
  return null;
}

function readToolFromReaperResult(payload: unknown): string | null {
  const obj = coerceObject(payload);
  if (obj && typeof obj.tool === "string") return obj.tool;
  return null;
}

// `tool_result_get` returns `{ ok, status: 'pending'|'done'|'error'|'unknown',
// result?, error?, ... }`. Pull out the inner payload the agent actually
// sees so the merged card shows the real tool output instead of the
// wrapper bookkeeping.
function unwrapReaperResult(payload: unknown): {
  kind: "done" | "error" | "pending" | "unknown";
  value: unknown;
} {
  const obj = coerceObject(payload);
  if (!obj) return { kind: "unknown", value: payload };
  const status = typeof obj.status === "string" ? obj.status : null;
  if (status === "done") {
    return { kind: "done", value: "result" in obj ? obj.result : obj };
  }
  if (status === "error") {
    return { kind: "error", value: "error" in obj ? obj.error : obj };
  }
  if (status === "pending") return { kind: "pending", value: obj };
  return { kind: "unknown", value: obj };
}

function coerceObject(payload: unknown): Record<string, unknown> | null {
  if (payload && typeof payload === "object") return payload as Record<string, unknown>;
  if (typeof payload === "string" && /^\s*{/.test(payload)) {
    try {
      const parsed = JSON.parse(payload);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return null;
}

// Persisted tool events come back through LangChain's Serializable JSON
// wrapper: `{ lc: 1, type: "constructor", id: [..., "ToolMessage"|"AIMessage"|...], kwargs: { content, ... } }`.
// The real tool payload lives in `kwargs.content` (or `kwargs.tool_input`
// for calls). Strip the wrapper — recursively, so nested wrappers also
// peel — so downstream extractors (argsSummary, argsFromResult, KV table)
// see the actual JSON content instead of LangChain plumbing.
//
// Payloads can come in as: an object; a JSON string of an object; a
// double-stringified JSON (the wallclock async store does
// `JSON.stringify(result)` where `result` is itself a JSON string from
// the inner tool, then the wrapped reaper output is stringified again
// when re-emitted as a ToolMessage). We peel string layers as long as
// JSON.parse keeps yielding something different.
function unwrapLangChainSerializable(payload: unknown, depth = 0): unknown {
  if (depth > 6) return payload; // safety bound

  // Peel string layers: a JSON string that parses to another string is
  // the double-stringify case. Keep parsing until we land on an object
  // or a string that's not valid JSON.
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed !== payload) return unwrapLangChainSerializable(parsed, depth + 1);
      } catch {
        // not JSON — fall through and return as-is below
      }
    }
    return payload;
  }

  const obj = coerceObject(payload);
  if (!obj) return payload;
  if (obj.lc === 1 && obj.type === "constructor" && Array.isArray(obj.id)) {
    const kwargs = coerceObject(obj.kwargs);
    if (kwargs) {
      // Tool result: `content` is the actual tool output (often a
      // JSON-stringified object). A `status: "error"` flag on the
      // wrapper means the wrapped content is an error message even
      // though it doesn't look like our usual `{ok:false,...}` shape.
      if ("content" in kwargs) {
        const content = kwargs.content;
        if (kwargs.status === "error" && typeof content === "string") {
          return { ok: false, error: content };
        }
        return unwrapLangChainSerializable(content, depth + 1);
      }
      // Tool call: AIMessage tool_calls carry the args under
      // `tool_calls[].args`; a direct ToolCall serialization uses
      // `args` or `tool_input`.
      if ("args" in kwargs) return unwrapLangChainSerializable(kwargs.args, depth + 1);
      if ("tool_input" in kwargs) return unwrapLangChainSerializable(kwargs.tool_input, depth + 1);
    }
  }
  return obj;
}
