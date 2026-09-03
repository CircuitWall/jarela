"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  Brain,
  CalendarDays,
  Check,
  ChevronRight,
  ClipboardCheck,
  FileText,
  FolderSearch,
  FolderTree,
  Globe,
  Image as ImageIcon,
  Inbox,
  Info,
  KeyRound,
  ListTree,
  MapPin,
  Mic,
  Plug,
  Power,
  Timer,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { CollapseChevron } from "@/components/ui/CollapseChevron";
import { MetaRow } from "@/components/ui/MetaRow";
import { ProviderLogo, brandSlugForToolName } from "@/components/models/ProviderLogo";

// Distinct lucide glyph per internal tool family so the chat transcript
// is glanceable — operator can tell a file write from a web fetch from a
// schedule from a memory read without reading the tool name.
//
// Keys are matched as exact tool names OR as a `<prefix>_` against the
// tool name; longest match wins. Anything unmatched falls back to the
// generic wrench (same as before).
const INTERNAL_TOOL_ICONS: ReadonlyArray<readonly [string, LucideIcon]> = [
  ["browser", Globe],
  ["web", Globe],
  ["calendar", CalendarDays],
  ["documents", FolderSearch],
  ["file", FileText],
  ["memory", Brain],
  ["workspace", FolderTree],
  ["local_exec", Terminal],
  ["terminal", Terminal],
  ["delegate_to_agent", Bot],
  ["generate_image", ImageIcon],
  ["generate_voice", Mic],
  ["tool_result", Inbox],
  ["schedule", Timer],
  ["cancel_scheduled_task", Timer],
  ["cancel_watcher", Timer],
  ["list_scheduled_tasks", Timer],
  ["list_watchers", Timer],
  ["propose_config_change", ClipboardCheck],
  ["check_proposal", ClipboardCheck],
  ["restart_server", Power],
  ["set_env_var", KeyRound],
  ["get_user_location", MapPin],
  ["list_integrations", Plug],
  ["get_integration_setup", Plug],
  ["list_mcp_servers", Plug],
  ["list_providers", Info],
  ["describe_provider", Info],
  ["describe_extension_surfaces", Info],
  ["list_reaction_scripts", ListTree],
  ["list_tools", Wrench],
];

// Sort once at module load, longest-key first, so `cancel_scheduled_task`
// beats `cancel` and `schedule` beats `schedule_task` (latter is already
// the prefix, but the principle keeps future entries deterministic).
const INTERNAL_TOOL_ICONS_SORTED = [...INTERNAL_TOOL_ICONS].sort(
  (a, b) => b[0].length - a[0].length,
);

function renderInternalToolIcon(name: string): ReactNode {
  const lower = name.toLowerCase();
  for (const [key, Icon] of INTERNAL_TOOL_ICONS_SORTED) {
    if (lower === key || lower.startsWith(key + "_")) {
      return <Icon size={11} className="shrink-0 text-fg-faint" aria-hidden />;
    }
  }
  return null;
}

// Tool names follow a `<brand>_<verb>_<noun>` convention (`gmail_send_email`,
// `github_create_issue`). When the prefix is a known brand we render its
// glyph; otherwise we try an internal-tool icon registry so each family
// has its own glanceable glyph instead of an undifferentiated wrench.
function ToolIcon({ toolName }: { toolName: string }) {
  const slug = brandSlugForToolName(toolName);
  if (slug) {
    return (
      <span className="shrink-0 text-fg-faint" aria-hidden>
        <ProviderLogo name={slug} size={11} />
      </span>
    );
  }
  const internal = renderInternalToolIcon(toolName);
  if (internal) return internal;
  return <Wrench size={11} className="shrink-0 text-fg-faint" aria-hidden />;
}

export interface ToolEvent {
  id: string;
  // "progress" can arrive any number of times between "call" and "result"
  // — incremental status from inside a still-running tool call (e.g.
  // claude_delegate relaying the sub-agent's own turns). `payload` is the
  // step text (a string). See ADR-0073.
  phase: "call" | "result" | "progress";
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
const HIDDEN_ARG_KEYS = new Set(["deadline_ms", "async_run", "stream"]);

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
    <MetaRow fullWidth onClick={onExpand} aria-label={`expand ${groups.length} tool calls`}>
      <ChevronRight size={9} className="shrink-0 text-fg-faint/70" />
      <ToolIcon toolName={visible[0] ?? ""} />
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
    </MetaRow>
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
  // True when the model reached the tool through the `invoke_tool`
  // dispatcher, so `name`/`args` were rewritten to the real target.
  viaInvokeTool: boolean;
  // Incremental status reported from inside the call via "progress" events
  // (ADR-0073). Empty for tools that never report progress — those render
  // the original synthetic wallclock progress bar unchanged.
  steps: string[];
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
        viaInvokeTool: false,
        steps: [],
      };
      map.set(ev.id, g);
      order.push(ev.id);
    }
    if (!g.name && ev.name) g.name = ev.name;
    if (ev.phase === "call") {
      g.args = unwrapLangChainSerializable(ev.payload);
      if (g.name === "invoke_tool") {
        const target = readInvokeToolTarget(g.args);
        if (target) {
          g.name = target.name;
          g.args = target.args;
          g.viaInvokeTool = true;
        }
      }
      const d = readDeadlineMs(g.args);
      if (d) g.deadlineMs = d;
    } else if (ev.phase === "progress") {
      if (typeof ev.payload === "string" && ev.payload) g.steps.push(ev.payload);
    } else {
      const raw = unwrapLangChainSerializable(ev.payload);
      // History persisted before the call event carried args (or when the
      // provider dropped it) still names the target in the result envelope.
      if (!g.viaInvokeTool && g.name === "invoke_tool") {
        const target = coerceObject(raw)?.tool;
        if (typeof target === "string" && target.trim()) {
          g.name = target.trim();
          g.viaInvokeTool = true;
        }
      }
      const payload = g.viaInvokeTool ? unwrapInvokeToolResult(raw) : raw;
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
  const claudeTranscript = claudeTranscriptFrom(group.name, effectiveArgs, group.result);
  const transcriptSteps = group.steps.length > 0 ? group.steps : claudeTranscript?.steps ?? stepsFromResult(group.result);
  return (
    <div className="min-w-0 max-w-full">
      <MetaRow fullWidth onClick={() => setOpen((v) => !v)} expanded={open}>
        <CollapseChevron open={open} size={9} className="text-fg-faint/70" />
        <ToolIcon toolName={group.name} />
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
        {isToolResultRefEnvelope(group.result) && (
          <Badge
            tone="info"
            className="uppercase tracking-wide"
            title="large result is shown as a preview with a file reference"
          >
            preview
          </Badge>
        )}
        {claudeTranscript?.awaitingUserAnswers && (
          <Badge
            tone="warning"
            className="uppercase tracking-wide"
            title="Claude asked design questions and is waiting for the user"
          >
            asks
          </Badge>
        )}
        <StatusIndicator
          status={group.status}
          deadlineMs={group.deadlineMs}
          startedAt={startedAt}
          stepCount={transcriptSteps.length}
        />
      </MetaRow>
      <LiveTranscript
        steps={transcriptSteps}
        parentMessage={claudeTranscript?.parentMessage}
        designQuestions={claudeTranscript?.designQuestions}
        launch={claudeTranscript?.launch}
      />
      {open && (
        <div className="mt-0.5 rounded border border-border/40 bg-surface-2/30 px-2 py-1.5 space-y-1.5 text-[10px]">
          <WorkflowProgressDetails group={group} />
          {hasVisibleArgs(group.args) ? (
            <DetailSection label="arguments" value={group.args} />
          ) : hasArgs ? (
            <DetailSection
              label="arguments (inferred from result)"
              value={effectiveArgs}
            />
          ) : null}
          {group.status !== "running" && group.status !== "async" && (
            isToolResultRefEnvelope(group.result) ? (
              <ToolResultRefDetails value={group.result} />
            ) : (
              <DetailSection
                label={group.status === "error" ? "error" : "result"}
                value={group.result}
                tone={group.status === "error" ? "error" : "default"}
              />
            )
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

function ToolResultRefDetails({ value }: { value: unknown }) {
  const envelope = readToolResultRefEnvelope(value);
  if (!envelope) return <DetailSection label="result" value={value} />;
  const ref = coerceObject(envelope.result_ref);
  const refName = typeof ref?.name === "string" ? ref.name : null;
  const uri = typeof ref?.uri === "string" ? ref.uri : refName ? `/api/v1/files/${encodeURIComponent(refName)}` : null;
  const mime = typeof ref?.mimeType === "string" ? ref.mimeType : null;
  return (
    <div className="min-w-0 rounded border border-sky-500/20 bg-sky-500/5 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="info" bordered className="uppercase tracking-wide">preview</Badge>
        <span className="text-[11px] text-fg-muted">
          {formatBytes(envelope.bytes)} stored out of context
        </span>
        {typeof envelope.total_count === "number" && (
          <span className="text-[11px] text-fg-faint">{envelope.total_count} items total</span>
        )}
      </div>
      {refName && (
        <div className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px] font-mono text-fg-muted">
          <span className="text-fg-faint">ref</span>
          <span className="min-w-0 break-all">{refName}</span>
          {mime && (
            <>
              <span className="text-fg-faint">type</span>
              <span className="min-w-0 break-all">{mime}</span>
            </>
          )}
          {uri && (
            <>
              <span className="text-fg-faint">file</span>
              <a href={uri} target="_blank" rel="noreferrer noopener" className="min-w-0 break-all text-sky-500 hover:underline">
                {uri}
              </a>
            </>
          )}
        </div>
      )}
      <div className="mt-1.5">
        <DetailSection label="preview" value={envelope.preview} />
      </div>
    </div>
  );
}

function WorkflowProgressDetails({ group }: { group: ToolCallGroup }) {
  if (group.name !== "workflow_progress") return null;
  const workflow = workflowProgressFrom(group.result) ?? workflowProgressPreviewFrom(group.args);
  if (!workflow) return null;
  return (
    <div className="rounded border border-border/40 bg-surface/60 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-fg-faint">workflow</span>
        <span className="text-[10px] uppercase tracking-wide text-fg-faint">{workflow.phase ?? workflow.workflow_id}</span>
      </div>
      {workflow.summary && (
        <p className="mt-1 text-[11px] leading-snug text-fg-muted">{workflow.summary}</p>
      )}
      <div className="mt-1.5 flex flex-col gap-1">
        {workflow.items.map((item) => (
          <div key={item.id} className="flex items-center justify-between gap-2 rounded border border-border/30 bg-surface-2/40 px-1.5 py-1">
            <span className="min-w-0 truncate text-[11px] text-fg-muted" title={item.label}>{item.label}</span>
            <WorkflowItemStatusBadge status={item.status} />
          </div>
        ))}
      </div>
    </div>
  );
}

interface WorkflowProgressView {
  workflow_id: string;
  phase: string | null;
  summary: string | null;
  items: Array<{ id: string; label: string; status: string }>;
}

function workflowProgressFrom(payload: unknown): WorkflowProgressView | null {
  const obj = coerceObject(unwrapLangChainSerializable(payload));
  if (!obj || typeof obj.workflow_id !== "string") return null;
  const state = coerceObject(obj.state);
  if (!state || !Array.isArray(state.checklist)) return null;
  return {
    workflow_id: String(obj.workflow_id),
    phase: typeof state.phase === "string" ? state.phase : null,
    summary: typeof state.summary === "string" ? state.summary : null,
    items: state.checklist.flatMap((raw) => {
      const item = coerceObject(raw);
      if (!item || typeof item.id !== "string" || typeof item.label !== "string") return [];
      return [{ id: item.id, label: item.label, status: typeof item.status === "string" ? item.status : "pending" }];
    }),
  };
}

function workflowProgressPreviewFrom(payload: unknown): WorkflowProgressView | null {
  const obj = coerceObject(unwrapLangChainSerializable(payload));
  if (!obj || typeof obj.workflow_id !== "string") return null;
  const itemId = typeof obj.item_id === "string" ? obj.item_id : null;
  const status = typeof obj.status === "string" ? obj.status : "checking";
  return {
    workflow_id: String(obj.workflow_id),
    phase: typeof obj.phase === "string" ? obj.phase : null,
    summary: typeof obj.detail === "string" ? obj.detail : null,
    items: itemId ? [{ id: itemId, label: itemId.replace(/-/g, " "), status }] : [],
  };
}

function WorkflowItemStatusBadge({ status }: { status: string }) {
  if (status === "done") {
    return (
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" aria-label="done">
        <Check size={10} strokeWidth={3} />
      </span>
    );
  }
  if (status === "checking") {
    return (
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-sky-500/40 bg-sky-500/10" aria-label="checking">
        <span className="h-1.5 w-1.5 rounded-full bg-sky-500/80 animate-pulse" aria-hidden />
      </span>
    );
  }
  if (status === "needs_attention") {
    return (
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400" aria-label="needs attention">
        <X size={10} strokeWidth={3} />
      </span>
    );
  }
  return (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border/60 bg-surface text-fg-faint" aria-label={status === "skipped" ? "skipped" : "pending"}>
      <span className="h-1.5 w-1.5 rounded-sm border border-current" aria-hidden />
    </span>
  );
}

// Marker prefixes are set by extractSteps in lib/tools/claude-delegate.ts
// ("Claude: ...", "→ Name: detail", "✓ Name: result", "✗ Name: error") —
// parsed here only to pick a per-row icon/tone; the wire format (SSE
// tool_progress payload) stays a plain string, so any tool can adopt the
// same convention without a schema change.
type StepKind = "text" | "call" | "result" | "error";

function classifyStep(step: string): { kind: StepKind; body: string } {
  if (step.startsWith("✓ ")) return { kind: "result", body: step.slice(2) };
  if (step.startsWith("✗ ")) return { kind: "error", body: step.slice(2) };
  if (step.startsWith("→ ")) return { kind: "call", body: step.slice(2) };
  return { kind: "text", body: step };
}

function StepIcon({ kind }: { kind: StepKind }) {
  if (kind === "result") {
    return <Check size={9} strokeWidth={3} className="shrink-0 text-emerald-500/80" aria-hidden />;
  }
  if (kind === "error") {
    return <X size={9} strokeWidth={3} className="shrink-0 text-rose-500/80" aria-hidden />;
  }
  if (kind === "call") {
    return <ChevronRight size={9} className="shrink-0 text-sky-500/70" aria-hidden />;
  }
  return <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-fg-faint/50" aria-hidden />;
}

function StepRow({ step }: { step: string }) {
  const { kind, body } = classifyStep(step);
  return (
    <div className="flex items-baseline gap-1.5 min-w-0 text-[10px] leading-[1.5]" title={body}>
      <StepIcon kind={kind} />
      <span
        className={`truncate min-w-0 ${
          kind === "error" ? "text-rose-600 dark:text-rose-300/90" : "text-fg-faint"
        }`}
      >
        {body}
      </span>
    </div>
  );
}

// Live per-call transcript (ADR-0073): nested directly under the tool
// call's own header row for the whole lifetime of the call, not gated
// behind the "expand raw args/result" toggle. Grows with content up to a
// capped height and auto-scrolls to the newest line; once it overflows,
// "read more" lifts the cap instead of forcing an inline scrollbar.
const TRANSCRIPT_COLLAPSED_MAX_PX = 112; // ~7 rows
const TRANSCRIPT_EXPANDED_MAX_PX = 320;

function LiveTranscript({
  steps,
  parentMessage,
  designQuestions = [],
  launch,
}: {
  steps: string[];
  parentMessage?: string;
  designQuestions?: string[];
  launch?: Record<string, unknown> | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hasMeta = !!parentMessage || !!launch || designQuestions.length > 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setOverflowing(el.scrollHeight > el.clientHeight);
  }, [steps.length, expanded, hasMeta, designQuestions.length]);

  if (steps.length === 0 && !hasMeta) return null;
  return (
    <div className="pl-[22px] -mt-0.5 min-w-0">
      <div
        ref={scrollRef}
        className="flex flex-col gap-0.5 overflow-y-auto rounded border border-border/30 bg-surface-2/20 px-1.5 py-1 transition-[max-height] duration-150 ease-out"
        style={{ maxHeight: expanded ? TRANSCRIPT_EXPANDED_MAX_PX : TRANSCRIPT_COLLAPSED_MAX_PX }}
      >
        {parentMessage && <TranscriptMetaRow label="Asked Claude" value={parentMessage} />}
        {launch && <TranscriptMetaRow label="Started" value={formatClaudeLaunchSummary(launch)} />}
        {steps.map((s, i) => (
          <StepRow key={i} step={s} />
        ))}
        {designQuestions.length > 0 && (
          <div className="mt-1 rounded border border-amber-500/30 bg-amber-500/5 px-1.5 py-1 text-[10px] leading-[1.45] text-amber-800 dark:text-amber-200">
            <div className="uppercase tracking-wide text-[9px] font-medium text-amber-700 dark:text-amber-300">Claude questions</div>
            <ol className="mt-0.5 list-decimal list-inside space-y-0.5">
              {designQuestions.map((question, i) => (
                <li key={i} className="break-words whitespace-pre-wrap">{question}</li>
              ))}
            </ol>
          </div>
        )}
      </div>
      {overflowing && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-[9px] uppercase tracking-wide text-fg-faint hover:text-fg-muted"
        >
          {expanded ? "show less" : "read more"}
        </button>
      )}
    </div>
  );
}

function TranscriptMetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 min-w-0 text-[10px] leading-[1.5]">
      <span className="uppercase tracking-wide text-[9px] text-fg-faint">{label}</span>
      <span className="min-w-0 truncate text-fg-muted" title={value}>{value}</span>
    </div>
  );
}

function StatusIndicator({
  status,
  deadlineMs,
  startedAt,
  stepCount,
}: {
  status: "running" | "ok" | "error" | "async";
  deadlineMs: number;
  startedAt: number;
  stepCount: number;
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
  // Once a call starts reporting real activity (ADR-0073), its wallclock
  // is idle-reset \u2014 a percent-toward-deadline bar would misleadingly read
  // "almost overdue" on a call that's actually healthy. Real step count is
  // the more honest signal for those; calls that never report progress
  // keep the original synthetic budget bar unchanged.
  if (stepCount > 0) return <LiveStepIndicator stepCount={stepCount} />;
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

// Shown instead of ProgressBar once a call reports real activity (ADR-0073)
// — a pulsing dot + step count, since the call's wallclock is idle-reset
// and no longer has a meaningful "percent toward deadline" to show.
function LiveStepIndicator({ stepCount }: { stepCount: number }) {
  return (
    <span
      className="shrink-0 inline-flex items-center gap-1 text-[10px] text-fg-faint tabular-nums"
      aria-label={`${stepCount} step${stepCount === 1 ? "" : "s"} so far`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-sky-500/80 animate-pulse" aria-hidden />
      {stepCount}
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
const SHELL_TOOL_NAMES = new Set(["local_exec", "terminal"]);

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

function stepsFromResult(result: unknown): string[] {
  const obj = coerceObject(result);
  if (!obj) return [];
  const nested = coerceObject(obj.result);
  const transcript = coerceObject(nested?.transcript) ?? coerceObject(obj.transcript);
  const steps = transcript?.claude_steps ?? obj.steps;
  if (!Array.isArray(steps)) return [];
  return steps.filter((step): step is string => typeof step === "string" && step.length > 0);
}

function claudeTranscriptFrom(toolName: string, args: unknown, result: unknown): {
  parentMessage?: string;
  steps: string[];
  designQuestions: string[];
  awaitingUserAnswers: boolean;
  launch: Record<string, unknown> | null;
} | null {
  if (toolName !== "claude_delegate" && toolName !== "claude_delegate_status") return null;
  const resultObj = coerceObject(result);
  const nestedResult = coerceObject(resultObj?.result);
  const transcript = coerceObject(nestedResult?.transcript) ?? coerceObject(resultObj?.transcript);
  const argsObj = coerceObject(args);
  const designQuestions = Array.isArray(transcript?.design_questions)
    ? transcript.design_questions.filter((q): q is string => typeof q === "string" && q.length > 0)
    : [];
  return {
    parentMessage: typeof transcript?.parent_message === "string"
      ? transcript.parent_message
      : typeof argsObj?.task === "string"
        ? argsObj.task
        : undefined,
    steps: stepsFromResult(result),
    designQuestions,
    awaitingUserAnswers: transcript?.awaiting_user_answers === true || resultObj?.awaiting_answers === true || nestedResult?.awaiting_answers === true,
    launch: coerceObject(transcript?.launch) ?? coerceObject(nestedResult?.launch) ?? coerceObject(resultObj?.launch),
  };
}

function formatClaudeLaunchSummary(launch: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof launch.model === "string" && launch.model) parts.push(`model ${launch.model}`);
  if (typeof launch.tools === "string" && launch.tools) parts.push(`tools ${launch.tools}`);
  if (typeof launch.permission_mode_used === "string") parts.push(`permission ${launch.permission_mode_used}`);
  if (typeof launch.timeout_seconds === "number") parts.push(`${launch.timeout_seconds}s timeout`);
  if (launch.background === true) parts.push("background");
  if (launch.sync_memory === false) parts.push("memory sync off");
  else if (typeof launch.sync_memory === "string") parts.push(`memory ${launch.sync_memory}`);
  return parts.length > 0 ? parts.join(" · ") : "default launch profile";
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

// `invoke_tool` is a dispatcher (lib/tools/invoke-tool.ts): the tool the user
// cares about is named in `name`, with its arguments in `args_json` (or the
// deprecated `args`). Resolve it so the card carries the target's icon, label
// and argument summary instead of an undifferentiated `invoke_tool` wrench.
function readInvokeToolTarget(args: unknown): { name: string; args: unknown } | null {
  const obj = coerceObject(args);
  if (!obj) return null;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) return null;
  const structured = coerceObject(obj.args);
  if (structured && Object.keys(structured).length > 0) return { name, args: structured };
  const fromJson = typeof obj.args_json === "string" ? coerceObject(obj.args_json) : null;
  return { name, args: fromJson ?? structured ?? {} };
}

// The dispatcher wraps a successful target return in
// `{ ok, tool, status, result }`. Peel it so result renderers see what the
// target actually produced. Failures keep the envelope — `isErrorPayload`
// reads `ok: false` / `error` off it.
function unwrapInvokeToolResult(payload: unknown): unknown {
  const obj = coerceObject(payload);
  if (!obj || obj.ok !== true || typeof obj.tool !== "string" || !("result" in obj)) return payload;
  return obj.result;
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

function isToolResultRefEnvelope(payload: unknown): boolean {
  return readToolResultRefEnvelope(payload) !== null;
}

function readToolResultRefEnvelope(payload: unknown): Record<string, unknown> | null {
  const obj = coerceObject(payload);
  if (!obj || obj.ok !== true || obj.truncated !== true) return null;
  if (typeof obj.bytes !== "number") return null;
  const ref = coerceObject(obj.result_ref);
  if (!ref || typeof ref.name !== "string") return null;
  return obj;
}

function formatBytes(bytes: unknown): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
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
