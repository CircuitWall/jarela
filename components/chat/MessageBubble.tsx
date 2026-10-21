"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, Bot, Brain, Check, Clock, Copy, CornerDownRight, Eye, EyeOff, ExternalLink, Link as LinkIcon, Link2, Loader2, MessageCircle, Paperclip, Pause, Play, RotateCcw, ShieldCheck, User, Users, Zap } from "lucide-react";
import type { AgentConfig, AutomationActivityMetadata, Message, RouteDecisionMetadata, UserProfile } from "@/api/types";
import type { ContentPart } from "@/api/types";
import { ToolList } from "@/components/chat/ToolList";
import { ContextUsageBar } from "@/components/chat/ContextUsageBar";
import { StructuredTurnCard, CATEGORY_BADGE } from "@/components/chat/StructuredTurnCard";
import { CollapseChevron } from "@/components/ui/CollapseChevron";
import { MetaRow } from "@/components/ui/MetaRow";
import { useAppContext } from "@/contexts/AppContext";
import { parseHref } from "@/lib/ui/navigate";
import { formatRoutingDecisionSummary, formatRoutingDuration, humanizeRouteClass } from "@/lib/ui/routing-decision";
import { pushToast } from "@/lib/ui/toasts";
import { parseBridgePrompt, type BridgePromptContext } from "@/lib/bridges/message-role";
import { parseExtensionTurn, type ExtensionTurnContext } from "@/lib/api/extension-turn-prompt";
import { errorMessage } from "@/lib/utils/error";
import { stripDeclaredReferencesFence } from "@/api/message-content";
import "highlight.js/styles/github-dark.css";
import { MarkdownContent, ContentPartView } from "./MessageContent";

interface ExtractedRef {
  title: string;
  url: string;
}

// Best-effort plain-text projection of a (possibly structured) message body
// for the TTS endpoint. Strips markdown noise, code fences, refs blocks,
// and structured content parts so the spoken output doesn't read aloud
// asterisks, backticks, or URLs. The string is also cropped to keep TTS
// requests cheap — voices read about 150wpm so 5000 chars is several minutes.
function plainTextForTts(content: unknown): string {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && "type" in part) {
        const p = part as { type: string; text?: string };
        if (p.type === "text" && typeof p.text === "string") text += `${p.text}\n`;
      }
    }
  }
  text = text
    .replace(/<refs>[\s\S]*?<\/refs>/gi, " ")
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 5000 ? text.slice(0, 5000) : text;
}

// Splits "<refs>…</refs>" off the end of a message, returning the parsed refs
// and the body without the block. Defensive against partial blocks emitted
// mid-stream and against the agent forgetting the closing tag.
function extractRefs(text: string): { body: string; refs: ExtractedRef[] } {
  const match = /<refs>([\s\S]*?)<\/refs>/i.exec(text);
  if (!match) return { body: text, refs: [] };
  const inner = match[1];
  const refs: ExtractedRef[] = [];
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(inner)) !== null) {
    const url = m[2].trim();
    if (/^https?:\/\//.test(url)) refs.push({ title: m[1].trim(), url });
  }
  // Also catch bare-URL lines for resilience.
  if (refs.length === 0) {
    for (const line of inner.split("\n")) {
      const u = line.trim().match(/^https?:\/\/\S+/);
      if (u) refs.push({ title: u[0].replace(/^https?:\/\/(www\.)?/, "").slice(0, 60), url: u[0] });
    }
  }
  const body = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trimEnd();
  return { body, refs };
}

// Detects messages produced by the page-capture endpoint (composeBody in
// lib/api/page-capture.ts) so the chat UI can render them as a collapsed
// card instead of dumping ~100KB of page text into the bubble. The format
// is fixed by composeBody; if either side changes, update both.
interface CapturedContext {
  title: string;
  url: string;
  selector: string | null;
  truncated: boolean;
  originalBytes: number | null;
  body: string;
}

function parseCapturedContext(raw: string): CapturedContext | null {
  if (!raw.startsWith("📎 Captured from ")) return null;
  const linkRe = /^📎 Captured from \[([^\]]+)\]\((https?:\/\/[^)]+)\)\s*\n?/;
  const bareRe = /^📎 Captured from <(https?:\/\/[^>]+)>\s*\n?/;
  let title = "";
  let url = "";
  let rest = raw;
  const lm = linkRe.exec(raw);
  if (lm) { title = lm[1]; url = lm[2]; rest = raw.slice(lm[0].length); }
  else {
    const bm = bareRe.exec(raw);
    if (!bm) return null;
    url = bm[1]; title = url; rest = raw.slice(bm[0].length);
  }
  const out: CapturedContext = { title, url, selector: null, truncated: false, originalBytes: null, body: "" };
  const sm = /^Element: `([^`]+)`\s*\n?/.exec(rest);
  if (sm) { out.selector = sm[1]; rest = rest.slice(sm[0].length); }
  const tm = /^>\s*⚠[^\n]*?\(original was ([\d,]+) bytes\)[^\n]*\n?/.exec(rest);
  if (tm) {
    out.truncated = true;
    out.originalBytes = Number(tm[1].replace(/,/g, ""));
    rest = rest.slice(tm[0].length);
  }
  rest = rest.replace(/^\s*\n/, "").replace(/^---\s*\n?/, "").replace(/^\n+/, "");
  out.body = rest;
  return out;
}

// Header-always-visible card for page captures. Body collapsed by default;
// the user can expand to read the captured page text inline. The agent
// already has the full text in the thread regardless of expand state — this
// is purely a UI affordance to keep ~100KB blobs from blowing the chat layout.
function CapturedContextCard({ ctx, accent }: { ctx: CapturedContext; accent: boolean }) {
  const hostname = (() => { try { return new URL(ctx.url).hostname; } catch { return ctx.url; } })();
  const chips = (
    <>
      <a
        href={ctx.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-1 underline decoration-dotted hover:decoration-solid truncate max-w-[18rem]"
        title={ctx.url}
      >
        <LinkIcon size={9} className="shrink-0" />
        <span className="truncate">{hostname}</span>
      </a>
      {ctx.selector && (
        <span
          className={`px-1.5 py-0.5 rounded font-mono ${accent ? "bg-white/15" : "bg-surface-3"}`}
          title={ctx.selector}
        >
          {ctx.selector.length > 36 ? `…${ctx.selector.slice(-33)}` : ctx.selector}
        </span>
      )}
      {ctx.truncated && (
        <span
          className={`px-1.5 py-0.5 rounded ${accent ? "bg-amber-300/25 text-amber-50" : "bg-amber-900/30 text-amber-300"}`}
          title={ctx.originalBytes ? `Original was ${ctx.originalBytes.toLocaleString()} bytes` : undefined}
        >
          truncated to 100KB
        </span>
      )}
    </>
  );
  const sections: Array<{ label: string; content: ReactNode; defaultOpen?: boolean; hint?: string }> = ctx.body
    ? [{
        label: "Captured content",
        defaultOpen: false,
        content: <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed opacity-90">{ctx.body}</p>,
      }]
    : [];
  return (
    <StructuredTurnCard
      categoryKey="page_capture"
      Icon={Paperclip}
      title={ctx.title || hostname}
      titleTooltip={ctx.url}
      chips={chips}
      sections={sections}
      accent={accent}
    />
  );
}

// Browser-extension turn card. The prompt format and parser live in
// `lib/api/extension-turn-prompt` so the compose/parse pair stays in sync
// between the server handler and this view.
function ExtensionTurnCard({ ctx, accent }: { ctx: ExtensionTurnContext; accent: boolean }) {
  const hostname = ctx.url ? (() => { try { return new URL(ctx.url!).hostname; } catch { return ctx.url!; } })() : null;
  const chips = (ctx.url || ctx.selector || ctx.selectedText) ? (
    <>
      {ctx.url && hostname && (
        <a
          href={ctx.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 underline decoration-dotted hover:decoration-solid truncate max-w-[18rem]"
          title={ctx.url}
        >
          <LinkIcon size={9} className="shrink-0" />
          <span className="truncate">{ctx.title || hostname}</span>
        </a>
      )}
      {ctx.selector && (
        <span
          className={`px-1.5 py-0.5 rounded font-mono ${accent ? "bg-white/15" : "bg-surface-3"}`}
          title={ctx.selector}
        >
          {ctx.selector.length > 36 ? `…${ctx.selector.slice(-33)}` : ctx.selector}
        </span>
      )}
      {ctx.selectedText && (
        <span className={`px-1.5 py-0.5 rounded ${accent ? "bg-white/15" : "bg-surface-3"}`}>
          {`${ctx.selectedText.length.toLocaleString()} chars selected`}
        </span>
      )}
    </>
  ) : null;

  const sections: Array<{ label: string; content: ReactNode; defaultOpen?: boolean; hint?: string }> = [];
  if (ctx.instruction) {
    sections.push({
      label: "Instruction",
      defaultOpen: false,
      content: <MarkdownContent text={ctx.instruction} />,
    });
  }
  if (ctx.selectedText || ctx.pageContext) {
    sections.push({
      label: "Context",
      defaultOpen: false,
      content: (
        <div className="flex flex-col gap-2">
          {ctx.selectedText && (
            <div>
              <div className={`text-[9.5px] uppercase tracking-wide mb-0.5 ${accent ? "text-white/55" : "text-fg-faint"}`}>Selected</div>
              <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed opacity-90">{ctx.selectedText}</p>
            </div>
          )}
          {ctx.pageContext && (
            <div>
              <div className={`text-[9.5px] uppercase tracking-wide mb-0.5 ${accent ? "text-white/55" : "text-fg-faint"}`}>Page</div>
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed opacity-80">{ctx.pageContext}</p>
            </div>
          )}
        </div>
      ),
    });
  }

  return (
    <StructuredTurnCard
      categoryKey="extension"
      Icon={Zap}
      title={ctx.actionLabel}
      chips={chips}
      sections={sections}
      accent={accent}
    />
  );
}

const AUTOMATION_ACTIVITY_SOURCE = {
  scheduled_task: { label: "Scheduled task", Icon: Clock },
  watcher: { label: "Watcher", Icon: Eye },
  bridge: { label: "Bridge", Icon: MessageCircle },
} satisfies Record<AutomationActivityMetadata["source_kind"], { label: string; Icon: React.ElementType }>;

const AUTOMATION_ACTIVITY_STATUS = {
  queued: { copy: "Queued", cls: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300" },
  checking: { copy: "Checking…", cls: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  action: { copy: "Action taken", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  no_action: { copy: "No action needed", cls: "border-border/50 bg-surface-2/60 text-fg-muted" },
  needs_approval: { copy: "Needs approval", cls: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  failed: { copy: "Failed", cls: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300" },
  cancelled: { copy: "Cancelled", cls: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300" },
  expired: { copy: "Expired", cls: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300" },
  complete: { copy: "Complete", cls: "border-border/50 bg-surface-2/60 text-fg-muted" },
} as const;

function activityStatus(activity: AutomationActivityMetadata) {
  const statusKey = activity.state === "complete"
    ? (activity.disposition ?? "complete")
    : activity.state;
  return AUTOMATION_ACTIVITY_STATUS[statusKey];
}

function AutomationActivityRow({ activity }: { activity: AutomationActivityMetadata }) {
  const [open, setOpen] = useState(false);
  const source = AUTOMATION_ACTIVITY_SOURCE[activity.source_kind];
  const status = activityStatus(activity);
  const details = [
    activity.detail ? { label: "Detail", value: activity.detail } : null,
    activity.preview ? { label: "Preview", value: activity.preview } : null,
    activity.error ? { label: "Error", value: activity.error } : null,
  ].filter((item): item is { label: string; value: string } => item !== null);
  const time = new Date(activity.last_at);
  const timeLabel = Number.isNaN(time.getTime())
    ? null
    : time.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const occurrenceLabel = activity.disposition === "no_action" && activity.occurrence_count > 1
    ? `${activity.occurrence_count} checks`
    : null;
  const SourceIcon = source.Icon;

  return (
    <div className="mb-1.5 flex w-full justify-center px-9" role="status" aria-atomic="true">
      <div className={`max-w-full rounded-md border px-2 py-1 text-[11px] ${status.cls}`}>
        <div className="flex min-w-0 items-center justify-center gap-1.5">
          <SourceIcon size={11} className="shrink-0" aria-hidden />
          <span className="shrink-0 font-medium">{source.label}</span>
          <span aria-hidden>·</span>
          <span className="truncate font-medium" title={activity.label}>{activity.label}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">{status.copy}</span>
          {occurrenceLabel ? <span className="shrink-0 opacity-70">· {occurrenceLabel}</span> : null}
          {timeLabel ? <time dateTime={activity.last_at} className="shrink-0 opacity-60">· {timeLabel}</time> : null}
          {details.length > 0 ? (
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="ml-0.5 inline-flex shrink-0 items-center rounded p-0.5 hover:bg-black/5 dark:hover:bg-white/10"
              aria-label={open ? "Hide automation activity details" : "Show automation activity details"}
              aria-expanded={open}
            >
              <CollapseChevron open={open} size={10} />
            </button>
          ) : null}
        </div>
        {open ? (
          <div className="mt-1.5 border-t border-current/15 pt-1.5">
            {details.map(({ label, value }) => (
              <div key={label} className="flex gap-1.5 whitespace-pre-wrap break-words">
                <span className="shrink-0 font-medium opacity-70">{label}:</span>
                <span className={label === "Error" ? "text-rose-700 dark:text-rose-300" : "text-fg-muted"}>{value}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CategorySourceBadge({ category }: { category: string }) {
  const def = CATEGORY_BADGE[category];
  if (!def) return null;
  const { label, Icon, cls } = def;
  return (
    <div className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-medium mb-1.5 self-start ${cls}`}>
      <Icon size={9} className="shrink-0" />
      <span>{label} reply</span>
    </div>
  );
}

// Auto-collapses any bubble whose rendered content would exceed `threshold`
// pixels. Applied to long user/assistant text so a captured-and-pasted code
// block or a multi-screen agent answer doesn't push the rest of the
// conversation off-screen. Detection is observation-based (ResizeObserver on
// scrollHeight) so it works for markdown, code blocks, images, and embeds
// uniformly without needing a per-content-type heuristic.
function CollapsibleLong({
  children,
  threshold = 480,
  accent,
  streaming = false,
  defaultOpen = false,
}: {
  children: React.ReactNode;
  threshold?: number;
  accent: boolean;
  streaming?: boolean;
  defaultOpen?: boolean;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  // Latched true once the user has been treated as "actively reading" this
  // bubble — either the first measurement saw the content fit, OR the
  // bubble was ever observed streaming, OR it was rendered as the latest
  // turn (just streamed, the user is mid-read). From that point, growing
  // past the threshold or remounting must NOT snap it closed.
  const firstFitRef = useRef(defaultOpen);
  const wasStreamingRef = useRef(false);
  if (streaming) wasStreamingRef.current = true;

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const check = () => {
      const over = el.scrollHeight > threshold + 24;
      setOverflows(over);
      if (!firstFitRef.current) {
        if (!over || wasStreamingRef.current || defaultOpen) {
          firstFitRef.current = true;
          setOpen(true);
        }
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [threshold, defaultOpen]);

  const collapsed = overflows && !open;

  return (
    <div className="flex flex-col min-w-0">
      <div
        ref={innerRef}
        className={collapsed ? "relative overflow-hidden min-w-0" : "min-w-0"}
        style={collapsed ? { maxHeight: threshold } : undefined}
      >
        {children}
        {collapsed && (
          <div
            className={`pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t ${
              accent ? "from-black/30" : "from-surface-1/90"
            } to-transparent`}
          />
        )}
      </div>
      {overflows && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`mt-1.5 self-start inline-flex items-center gap-1 text-[11px] ${
            accent ? "text-white/85 hover:text-white" : "text-fg-faint hover:text-fg-muted"
          }`}
          aria-expanded={open}
        >
          <CollapseChevron open={open} size={10} />
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

type Props = {
  message: Message | { role: "assistant"; content: string; streaming?: boolean };
  attachedActivity?: AutomationActivityMetadata;
  agentConfig?: AgentConfig | null;
  userProfile?: UserProfile | null;
  showAvatar?: boolean;
  threadId?: string | null;
  // When false, suppress the inline ToolList for this message. Driven by
  // the chat-panel filter toolbar's `tool_use` toggle.
  showToolEvents?: boolean;
  // Thread-level fallback for the ContextUsageBar baseline when a row's
  // usage snapshot predates the per-row context_window_tokens column.
  contextWindowTokens?: number | null;
  // True for the very last message in the rendered list. The just-streamed
  // assistant turn the user is currently reading must NOT auto-collapse
  // when its persisted version mounts (different component instance from
  // the streaming bubble, so the streaming-latch can't carry over).
  isLatest?: boolean;
  // Resend this user prompt as a new turn. Hidden when undefined; also
  // hidden for category-tagged messages (bridge / scheduled_task / watcher)
  // since those originate from automation and re-sending the persisted
  // body would replay it as a regular user prompt.
  onRetry?: (text: string, attachments: ContentPart[], messageId?: string) => void;
};

const GRADIENTS = [
  "from-violet-500 to-indigo-600",
  "from-blue-500 to-cyan-600",
  "from-emerald-500 to-teal-600",
  "from-orange-500 to-amber-600",
  "from-rose-500 to-pink-600",
  "from-fuchsia-500 to-purple-600",
];

function gradientFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(h) % GRADIENTS.length];
}

function AgentAvatar({ config }: { config?: AgentConfig | null }) {
  if (config?.icon) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={config.icon} alt={config.name} className="w-7 h-7 rounded-lg object-cover" />;
  }
  if (config) {
    return (
      <div className={`w-7 h-7 rounded-lg bg-gradient-to-br ${gradientFor(config.id)} flex items-center justify-center text-xs font-bold text-white select-none`}>
        {config.name.charAt(0).toUpperCase()}
      </div>
    );
  }
  return (
    <div className="w-7 h-7 rounded-lg bg-surface-3 flex items-center justify-center">
      <Bot size={13} className="text-fg-faint" />
    </div>
  );
}

function UserAvatar({ profile }: { profile?: UserProfile | null }) {
  if (profile?.icon) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={profile.icon} alt={profile.name || "You"} className="w-7 h-7 rounded-lg object-cover" />;
  }
  if (profile?.name) {
    return (
      <div className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center text-xs font-bold text-white select-none">
        {profile.name.charAt(0).toUpperCase()}
      </div>
    );
  }
  return (
    <div className="w-7 h-7 rounded-lg bg-surface-3 flex items-center justify-center">
      <User size={13} className="text-fg-faint" />
    </div>
  );
}

// Detects messages forwarded by the bridge dispatcher (lib/bridges/dispatcher.ts:
// `contextLines.join("\n") + "\n\n" + msg.text`) so the chat UI can render the
// metadata as a compact header card instead of dumping six bracketed `[key:value]`
// lines at the top of every bubble. Format is fixed by dispatcher; if either
// side changes, update both.
const parseBridgeContext = parseBridgePrompt;

const SILENT_TRIGGER_RE = /\n+\[SILENT_TRIGGER\][^\n]*(?:\n(?!\n).*)*$/;

interface ScheduledTaskCardData {
  kind: "scheduled_task";
  prompt: string;
  silent: boolean;
}

interface WatcherCardData {
  kind: "watcher";
  label: string;
  tool: string;
  args: string;
  diff: string;
  directive: string;
  silent: boolean;
}

type TriggerCardData = ScheduledTaskCardData | WatcherCardData;

// Strip the `[SILENT_TRIGGER] …` envelope that runTriggerAgent appends
// in silent mode so the card can render the user's original prompt and
// surface a separate "Silent" pill instead of leaking framework prose.
function stripSilentEnvelope(text: string): { text: string; silent: boolean } {
  const m = SILENT_TRIGGER_RE.exec(text);
  if (!m) return { text, silent: false };
  return { text: text.slice(0, m.index).trimEnd(), silent: true };
}

function parseTriggerMessage(category: string | null | undefined, raw: string): TriggerCardData | null {
  if (category === "scheduled_task") {
    const { text, silent } = stripSilentEnvelope(raw);
    return { kind: "scheduled_task", prompt: text, silent };
  }
  if (category === "watcher") {
    const { text, silent } = stripSilentEnvelope(raw);
    const headerRe = /^Watcher\s+"([^"]*)"\s+detected a change\.\s*\n+Tool:\s*([^\n]+)\s*\nArgs:\s*([\s\S]*?)\n+---\s*Diff[^\n]*---\s*\n([\s\S]*?)\n\n([\s\S]*)$/;
    const m = headerRe.exec(text);
    if (!m) return null;
    return {
      kind: "watcher",
      label: m[1],
      tool: m[2].trim(),
      args: m[3].trim(),
      diff: m[4].trim(),
      directive: m[5].trim(),
      silent,
    };
  }
  return null;
}

// Compact header card for trigger-originated user messages (scheduled
// tasks + watchers, ADR-0027/ADR-0032). Surfaces the trigger type with
// an icon + label so the operator can tell at a glance that the prompt
// came from automation and not from them. Watchers additionally expose
// the diff context in a collapsed section to keep large diffs out of
// the main bubble height.
function TriggerMessageCard({ data }: { data: TriggerCardData }) {
  const Icon = data.kind === "scheduled_task" ? Clock : Eye;
  const title = data.kind === "scheduled_task" ? "Scheduled task" : `Watcher: ${data.label || "(unnamed)"}`;
  const chips = (data.kind === "watcher" || data.silent) ? (
    <>
      {data.kind === "watcher" && (
        <span className="px-1.5 py-0.5 rounded-full bg-white/15 text-[9.5px] uppercase tracking-wide shrink-0">
          {data.tool}
        </span>
      )}
      {data.silent && (
        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-white/15 text-[9.5px] uppercase tracking-wide shrink-0" title="Silent trigger: reply only if material">
          <EyeOff size={9} />
          silent
        </span>
      )}
    </>
  ) : null;

  const body = data.kind === "scheduled_task" ? data.prompt : data.directive;
  const sections: Array<{ label: string; content: ReactNode; defaultOpen?: boolean; hint?: string }> = [
    {
      label: data.kind === "scheduled_task" ? "Prompt" : "Directive",
      defaultOpen: true,
      content: <MarkdownContent text={body} />,
    },
  ];
  if (data.kind === "watcher" && (data.args || data.diff)) {
    sections.push({
      label: "Change context",
      defaultOpen: false,
      content: (
        <div className="flex flex-col gap-1">
          {data.args && <pre className="m-0 px-2 py-1.5 rounded bg-black/25 text-[11px] leading-snug whitespace-pre-wrap break-words text-white/90 max-h-72 overflow-auto">{data.args}</pre>}
          {data.diff && <pre className="m-0 px-2 py-1.5 rounded bg-black/25 text-[11px] leading-snug whitespace-pre-wrap break-words text-white/90 max-h-96 overflow-auto">{data.diff}</pre>}
        </div>
      ),
    });
  }

  return (
    <StructuredTurnCard
      categoryKey={data.kind === "scheduled_task" ? "scheduled_task" : "watcher"}
      Icon={Icon}
      title={title}
      chips={chips}
      sections={sections}
      accent={true}
    />
  );
}

// Compact header card for inbound bridge messages. Shows sender + chat
// context as a single line of metadata above the actual message text, so a
// WhatsApp DM looks like "Alice • DM\n<text>" and a group message looks
// like "Alice in Family Chat • Group\n<text>". Always on the user-bubble
// (accent) side because bridge messages are persisted with role=user.
function BridgeMessageCard({ ctx, activity }: {
  ctx: BridgePromptContext;
  activity?: AutomationActivityMetadata;
}) {
  const showChat = ctx.isGroup && ctx.chatName && ctx.chatName !== ctx.senderName;
  const title = showChat ? `${ctx.senderName} in ${ctx.chatName}` : ctx.senderName;
  const Icon = ctx.isGroup ? Users : MessageCircle;
  const chips = (
    <>
      <span className="px-1.5 py-0.5 rounded-full bg-white/15 text-[9.5px] uppercase tracking-wide shrink-0">
        {ctx.isGroup ? "group" : "dm"}
      </span>
      {activity ? (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-white/15 text-[9.5px] shrink-0">
          {activityStatus(activity).copy}
          {activity.occurrence_count > 1 ? ` · ${activity.occurrence_count} checks` : ""}
        </span>
      ) : null}
      {ctx.chatLink ? (
        <a
          href={ctx.chatLink}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-white/15 hover:bg-white/25 text-[9.5px] shrink-0"
          title={`Open this chat (${ctx.chatLink})`}
        >
          <ExternalLink size={9} />
          open chat
        </a>
      ) : null}
    </>
  );
  const sections: Array<{ label: string; content: ReactNode; defaultOpen?: boolean; hint?: string }> = [
    {
      label: "Message",
      defaultOpen: true,
      hint: ctx.body ? undefined : "(empty)",
      content: ctx.body ? (
        <MarkdownContent text={ctx.body} />
      ) : (
        <p className="text-[12px] italic text-white/65">(empty message)</p>
      ),
    },
  ];
  return (
    <StructuredTurnCard
      categoryKey="bridge"
      Icon={Icon}
      title={title}
      titleTooltip={ctx.senderJid}
      chips={chips}
      sections={sections}
      accent={true}
    />
  );
}

function parseContent(raw: string): string | ContentPart[] {
  if (!raw.startsWith("[")) return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      typeof parsed[0] === "object" &&
      parsed[0] !== null &&
      "type" in (parsed[0] as object)
    ) {
      return parsed as ContentPart[];
    }
  } catch {
    // not valid JSON content
  }
  return raw;
}

function ReferencesPanel({ sources }: { sources: ReadonlyArray<{ n: number; label: string; href: string }> }) {
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] text-fg-faint hover:text-fg-muted transition-colors"
        aria-expanded={open}
      >
        <CollapseChevron open={open} size={10} />
        <LinkIcon size={10} />
        <span>{sources.length} {sources.length === 1 ? "reference" : "references"}</span>
      </button>
      {open && (
        <ol className="mt-1 space-y-0.5 pl-4 list-none">
          {sources.map((s) => {
            const isAnchor = s.href.startsWith("#");
            const isMemory = s.href.startsWith("memory://");
            return (
              <li key={s.n} className="text-[11px] flex items-start gap-1.5">
                <span className="text-fg-faint tabular-nums shrink-0 w-5 text-right">[{s.n}]</span>
                {isAnchor || isMemory ? (
                  <a
                    href={isAnchor ? s.href : "#"}
                    onClick={isMemory ? (e) => e.preventDefault() : undefined}
                    className="text-sky-700 dark:text-sky-400 hover:underline truncate inline-block max-w-full align-middle"
                    title={s.href}
                  >
                    {s.label}
                  </a>
                ) : (
                  <a
                    href={s.href}
                    target={s.href.startsWith("http") ? "_blank" : undefined}
                    rel={s.href.startsWith("http") ? "noopener noreferrer" : undefined}
                    className="text-sky-700 dark:text-sky-400 hover:underline truncate inline-block max-w-full align-middle"
                    title={s.href}
                  >
                    {s.label}
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function CitationsSummary({ claims, checkerModel }: { claims: ReadonlyArray<{ text?: string; link: string | null; verified: boolean; reason?: string; impact?: "high" | "med" | "low" }>; checkerModel: string }) {
  const [open, setOpen] = useState(false);
  if (claims.length === 0) return null;

  // Group + count by impact so the trigger is a compact, scannable summary.
  type ClaimT = (typeof claims)[number];
  const buckets: Record<"high" | "med" | "low", ClaimT[]> = { high: [], med: [], low: [] };
  for (const c of claims) {
    const k = c.impact === "high" ? "high" : c.impact === "low" ? "low" : "med";
    buckets[k].push(c);
  }
  const uncitedHigh = buckets.high.filter((c) => !c.verified).length;
  const totalUncited = claims.filter((c) => !c.verified).length;
  const total = claims.length;
  const allCited = totalUncited === 0;

  // Trigger label prefers the loudest signal: uncited-high > total uncited > all good.
  const trigger = uncitedHigh > 0
    ? `${uncitedHigh} high-impact claim${uncitedHigh === 1 ? "" : "s"} uncited`
    : totalUncited > 0
      ? `${totalUncited} of ${total} claim${total === 1 ? "" : "s"} uncited`
      : `${total} claim${total === 1 ? "" : "s"} cited`;

  const impactBadge = (impact: "high" | "med" | "low") => {
    const styles =
      impact === "high" ? "bg-warn/15 text-warn"
      : impact === "low" ? "bg-fg-faint/10 text-fg-faint"
      : "bg-fg-subtle/15 text-fg-subtle";
    return (
      <span className={`text-[9px] uppercase tracking-wider px-1 py-px rounded ${styles} shrink-0`}>
        {impact}
      </span>
    );
  };

  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 text-[11px] transition-colors ${allCited ? "text-fg-faint hover:text-fg-muted" : "text-warn hover:opacity-80"}`}
        title={checkerModel ? `Citations checked by ${checkerModel}` : undefined}
        aria-expanded={open}
      >
        <CollapseChevron open={open} size={10} />
        <span>{trigger}</span>
      </button>
      {open && (
        <div className="mt-1 pl-4 space-y-2">
          {(["high", "med", "low"] as const).map((bucket) => {
            const list = buckets[bucket];
            if (list.length === 0) return null;
            return (
              <ul key={bucket} className="space-y-0.5">
                {list.map((c, i) => (
                  <li key={`${bucket}-${i}`} className={`text-[11px] flex items-start gap-1.5 ${c.verified ? "text-fg-subtle" : "text-warn"}`}>
                    <span className="shrink-0">{c.verified ? "✓" : "⚠"}</span>
                    {impactBadge(bucket)}
                    <span className="min-w-0 flex-1">
                      <span>{c.text ?? "(claim)"}</span>
                      {c.link && (
                        <span className="ml-1 text-fg-faint truncate inline-block max-w-[60ch] align-middle">— {c.link}</span>
                      )}
                      {!c.verified && c.reason && (
                        <span className="block text-[10px] text-fg-faint italic mt-px">{c.reason}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Shield indicator (ADR-0064 transparency requirement). Renders when the
// turn redacted at least one sensitive value before sending to the LLM.
// The user's local view always shows real values (rehydrated at render
// time) — this affordance is the visible signal that secrets stayed on
// the device. Tooltip explains the trust boundary; click expands to a
// per-type breakdown.
function RedactionShield({
  summary,
}: {
  summary: ReadonlyArray<{ type_hint: string; count: number }>;
}) {
  const [open, setOpen] = useState(false);
  if (summary.length === 0) return null;
  const total = summary.reduce((acc, e) => acc + e.count, 0);
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400/85 hover:opacity-80 transition-colors"
        title="Sensitive values were replaced with placeholders before being sent to the LLM. Real values stayed on this device."
        aria-expanded={open}
      >
        <CollapseChevron open={open} size={10} />
        <ShieldCheck size={11} />
        <span>{total} {total === 1 ? "value" : "values"} held back from LLM</span>
      </button>
      {open && (
        <div className="mt-1 pl-4">
          <ul className="space-y-0.5">
            {summary.map((e, i) => (
              <li key={`${e.type_hint}-${i}`} className="text-[11px] text-fg-muted">
                <span className="tabular-nums">{e.count}</span>
                {" × "}
                <span className="font-mono opacity-85">{e.type_hint}</span>
              </li>
            ))}
          </ul>
          <div className="mt-1 text-[10px] text-fg-faint italic">
            Real values stay on this device. Add patterns at <span className="font-mono">~/.jarela/redaction-patterns.json</span>.
          </div>
        </div>
      )}
    </div>
  );
}

// Quiet per-turn indicator that the automatic semantic recall pass (see
// buildRecallContext in lib/agents/run-thread.ts) surfaced something.
// Counts only, never the recalled content itself — an earlier design that
// dumped every recalled item into the citation manifest was reverted for
// producing a noisy, mostly-irrelevant panel on every reply.
function MemoryRecallBadge({ memoryHits, messageHits }: { memoryHits: number; messageHits: number }) {
  const total = memoryHits + messageHits;
  if (total <= 0) return null;
  const parts = [
    memoryHits > 0 ? `${memoryHits} ${memoryHits === 1 ? "memory" : "memories"}` : null,
    messageHits > 0 ? `${messageHits} past ${messageHits === 1 ? "message" : "messages"}` : null,
  ].filter(Boolean);
  return (
    <MetaRow
      accent="neutral"
      title="The agent's automatic memory recall pass surfaced these before drafting this reply."
    >
      <Brain size={10} />
      <span className="truncate">Recalled {parts.join(" · ")}</span>
    </MetaRow>
  );
}

function RoutingDecisionSummary({ decision }: { decision: RouteDecisionMetadata }) {
  const [open, setOpen] = useState(false);
  const summary = formatRoutingDecisionSummary(decision);
  return (
    <div className="mt-1 flex flex-col items-start gap-0.5">
      <MetaRow accent="sky" onClick={() => setOpen((v) => !v)} expanded={open} title={decision.reason}>
        <CollapseChevron open={open} size={9} />
        <Zap size={10} />
        <span className="truncate max-w-[24rem] text-left">{summary}</span>
      </MetaRow>
      {open && (
        <div className="ml-2 mt-1 rounded border border-border/60 bg-surface-2/70 px-2.5 py-2 space-y-1 text-[11px] text-fg-muted">
          <div>
            <span className="text-fg-faint">source:</span>{" "}
            <span className="font-mono">{decision.source}</span>
          </div>
          {decision.route_class && (
            <div>
              <span className="text-fg-faint">class:</span>{" "}
              <span>{humanizeRouteClass(decision.route_class)}</span>
            </div>
          )}
          {decision.policy && (
            <div>
              <span className="text-fg-faint">policy:</span>{" "}
              <span className="font-mono">{decision.policy}</span>
            </div>
          )}
          {typeof decision.duration_ms === "number" && decision.duration_ms > 0 && (
            <div>
              <span className="text-fg-faint">latency:</span>{" "}
              <span className="font-mono">{formatRoutingDuration(decision.duration_ms)}</span>
            </div>
          )}
          {typeof decision.retry_count === "number" && decision.retry_count > 0 && (
            <div>
              <span className="text-fg-faint">retries:</span>{" "}
              <span className="font-mono">{decision.retry_count}</span>
            </div>
          )}
          {decision.terminal && (
            <div>
              <span className="text-fg-faint">result:</span>{" "}
              <span className="font-mono">{decision.terminal}</span>
              {decision.error_code ? <span className="text-fg-faint"> · {decision.error_code}</span> : null}
            </div>
          )}
          {Array.isArray(decision.candidates) && decision.candidates.length > 0 && (
            <div>
              <span className="text-fg-faint">candidates:</span>{" "}
              <span>{decision.candidates.join(", ")}</span>
            </div>
          )}
          <div className="italic text-fg-faint">{decision.reason}</div>
        </div>
      )}
    </div>
  );
}

function RefsFooter({ refs }: { refs: ExtractedRef[] }) {
  const [open, setOpen] = useState(false);
  if (refs.length === 0) return null;
  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] text-fg-faint hover:text-fg-muted transition-colors"
      >
        <CollapseChevron open={open} size={10} />
        <LinkIcon size={10} />
        <span>{refs.length} {refs.length === 1 ? "reference" : "references"}</span>
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 pl-4">
          {refs.map((r, i) => (
            <li key={`${i}-${r.url}`} className="text-[11px]">
              <a
                href={r.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sky-700 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 hover:underline truncate inline-block max-w-full align-middle"
                title={r.url}
              >
                {r.title || r.url}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function hasImageAttachment(content: string | ContentPart[]): boolean {
  return Array.isArray(content) && content.some((part) => part.type === "image" || part.type === "image_ref");
}

function messageTextForCopy(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "file") return `[File: ${part.name}]`;
    if (part.type === "image") return `[Image: ${part.media_type}]`;
    if (part.type === "image_ref") return `[Image: ${part.media_type}]`;
    return "";
  }).filter(Boolean).join("\n\n");
}

// Memoized: while a run streams, ChatView re-renders on every text_delta to
// update the live streaming bubble. Without React.memo, every persisted
// MessageBubble re-renders too — for a 50-message thread that's 50
// reconciliations per character. Props are pure data (no callbacks), and
// `messages` array preserves identity for unchanged rows after the
// `concat` in handleDone, so default shallow-equality is enough.
export const MessageBubble = memo(function MessageBubble({ message, attachedActivity, agentConfig, userProfile, showAvatar = true, threadId = null, showToolEvents = true, contextWindowTokens = null, isLatest = false, onRetry }: Props) {
  const { dispatch } = useAppContext();
  const isUser = message.role === "user";
  const streaming = "streaming" in message && message.streaming;
  const transcriptStatus = "transcript_status" in message ? message.transcript_status : undefined;
  const statusReason = "status_reason" in message ? message.status_reason : null;
  // Memoize the JSON-or-plain-text parse: `parseContent` runs JSON.parse on
  // anything that looks like a serialized ContentPart[]. For the streaming
  // bubble this is called on every rAF flush as `content` grows; without
  // memoization we'd re-parse the entire (growing) blob each frame.
  const parsed = useMemo(() => parseContent(message.content), [message.content]);
  const messageId = "id" in message ? message.id : null;
  const containsImageAttachment = hasImageAttachment(parsed);

  const handleInAppLink = useCallback((href: string) => {
    const p = parseHref(href);
    // A `thread`+`agent` pair (emitted by delegate_to_agent's cite_as link
    // and by toast deep links) is a SELECT_THREAD intent — fire the
    // dedicated action so AppShell sets activeThreadId AND activeAgentId
    // atomically. Falling back to SET_TAB+SET_SELECTION would not load the
    // thread because chat tab keys off activeThreadId, not selectedItem.
    if (p.thread && p.agent) {
      dispatch({ type: "SELECT_THREAD", threadId: p.thread, agentId: p.agent });
    } else if (p.tab) {
      dispatch({ type: "SET_TAB", tab: p.tab });
      dispatch({ type: "SET_SELECTION", tab: p.tab, itemId: p.item ?? null });
    }
    if (p.hash && typeof window !== "undefined") {
      const samePath = `${window.location.pathname}${window.location.search}`;
      // Force a hashchange even if the hash matches the current value so the
      // in-thread anchor scrolls again on repeat clicks.
      if (window.location.hash === `#${p.hash}`) {
        window.history.replaceState(null, "", samePath);
      }
      window.history.replaceState(null, "", `${samePath}#${p.hash}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
  }, [dispatch]);

  const copyLink = useCallback(() => {
    if (!messageId || typeof window === "undefined") return;
    const params = new URLSearchParams();
    if (threadId) params.set("thread", threadId);
    const qs = params.toString();
    const url = `${window.location.origin}/${qs ? `?${qs}` : ""}#msg-${messageId}`;
    void navigator.clipboard.writeText(url).then(() => {
      pushToast({
        kind: "success",
        source: "system",
        sourceLabel: "Chat",
        title: "Link copied",
        body: "Paste anywhere to jump back to this message.",
        agent_id: null,
        thread_id: threadId,
        ttl: 2200,
      });
    }).catch(console.error);
  }, [messageId, threadId]);

  // Retry only makes sense for plain user prompts the operator typed. Bridge
  // / scheduled-task / watcher rows carry their own metadata header and
  // re-sending them as a vanilla user message would be wrong.
  const category = "category" in message ? message.category : null;
  const retryMessageId = "id" in message ? message.id : undefined;
  const canRetry = isUser && !category && !!onRetry && !streaming;
  const handleRetry = useCallback(() => {
    if (!onRetry) return;
    if (typeof parsed === "string") {
      onRetry(parsed, [], retryMessageId);
      return;
    }
    let text = "";
    const atts: ContentPart[] = [];
    for (const part of parsed) {
      if (part.type === "text" && !text) text = part.text;
      else atts.push(part);
    }
    onRetry(text, atts, retryMessageId);
  }, [onRetry, parsed, retryMessageId]);

  const [copiedMessage, setCopiedMessage] = useState(false);
  const copyMessage = useCallback(() => {
    const text = messageTextForCopy(parsed);
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedMessage(true);
      setTimeout(() => setCopiedMessage(false), 1200);
      pushToast({
        kind: "success",
        source: "system",
        sourceLabel: "Chat",
        title: "Message copied",
        body: "Copied message content to clipboard.",
        agent_id: null,
        thread_id: threadId,
        ttl: 2000,
      });
    }).catch(console.error);
  }, [parsed, threadId]);

  // —— TTS playback ——
  // The Play button is rendered for assistant bubbles whose agent has
  // voice_enabled. We don't pre-generate audio — the first click POSTs the
  // plain-text body to /api/v1/voice/tts and plays the returned WAV. The
  // <audio> element is created lazily and the object URL is revoked on
  // unmount to avoid leaks. Auto-speak listens for a window event keyed by
  // messageId so ChatView can arm it from outside the bubble.
  const voiceEnabled = !isUser && !!agentConfig?.voice_enabled;
  const ttsAbleText = !isUser ? plainTextForTts(message.content) : "";
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const [audioState, setAudioState] = useState<"idle" | "loading" | "playing" | "paused" | "error">("idle");
  const [audioError, setAudioError] = useState<string | null>(null);

  const releaseAudio = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      try { a.pause(); } catch { /* ignore */ }
      a.src = "";
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  useEffect(() => () => releaseAudio(), [releaseAudio]);

  const speak = useCallback(async () => {
    if (!voiceEnabled || !agentConfig || streaming) return;
    if (!ttsAbleText.trim()) return;
    // Resume an existing buffer instead of re-fetching.
    if (audioRef.current && audioUrlRef.current) {
      if (audioState === "playing") {
        audioRef.current.pause();
        setAudioState("paused");
      } else {
        try { await audioRef.current.play(); setAudioState("playing"); }
        catch (err) { setAudioError(errorMessage(err)); setAudioState("error"); }
      }
      return;
    }
    setAudioError(null);
    setAudioState("loading");
    try {
      const res = await fetch("/api/v1/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentConfig.id, text: ttsAbleText }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audio.onended = () => setAudioState("idle");
      audio.onpause = () => setAudioState((s) => (s === "playing" ? "paused" : s));
      audio.onerror = () => { setAudioState("error"); setAudioError("playback failed"); };
      audioRef.current = audio;
      await audio.play();
      setAudioState("playing");
    } catch (err) {
      setAudioError(errorMessage(err));
      setAudioState("error");
    }
  }, [voiceEnabled, agentConfig, streaming, ttsAbleText, audioState]);

  useEffect(() => {
    if (!voiceEnabled || !messageId) return;
    function onSpeak(e: Event) {
      const detail = (e as CustomEvent<{ messageId?: string }>).detail;
      if (detail?.messageId === messageId) void speak();
    }
    window.addEventListener("jarela:speak-message", onSpeak as EventListener);
    return () => window.removeEventListener("jarela:speak-message", onSpeak as EventListener);
  }, [voiceEnabled, messageId, speak]);

  // Extract <refs> from assistant messages so they render as a compact footer
  // under the bubble instead of inline. While streaming, only show them after
  // the closing </refs> tag has arrived (otherwise we'd flicker partial refs).
  let refs: ExtractedRef[] = [];
  let renderedString: string | null = null;
  if (!isUser && typeof parsed === "string") {
    if (!streaming || /<\/refs>/i.test(parsed)) {
      const r = extractRefs(parsed);
      renderedString = r.body;
      refs = r.refs;
    } else {
      renderedString = parsed;
    }
    // Also hide the agent's trailing ```jarela-references` JSON block —
    // this is a machine-readable side channel for populating the citation
    // manifest, not user-facing prose. The server strips it before
    // persisting, but the streaming buffer still carries it until the
    // turn ends, so we'd otherwise flash raw JSON for one frame.
    if (renderedString) {
      renderedString = stripDeclaredReferencesFence(renderedString);
    }
  }

  // Citation-checker verdict from messages.metadata. Present whenever the
  // agent's `citation_strictness` is not `off` AND a checker model is
  // configured AND the checker call succeeded. The checker emits one row
  // per factual claim, ranked by impact (high → med → low).
  const citations = !isUser && "metadata" in message
    ? (message.metadata as { citations?: { checker_model?: string; claims?: Array<{ text?: string; link: string | null; verified: boolean; reason?: string; impact?: "high" | "med" | "low" }>; unverified_links?: string[]; sources?: Array<{ n: number; label: string; href: string }> } } | null | undefined)?.citations ?? null
    : null;
  // ADR-0064 transparency surface — values the redaction layer kept off
  // the wire during this turn. Read from the same metadata blob; absent
  // on legacy rows and on turns where nothing matched.
  const redactionSummary = !isUser && "metadata" in message
    ? (message.metadata as { redaction_summary?: Array<{ type_hint: string; count: number }> } | null | undefined)?.redaction_summary ?? null
    : null;
  const routingDecision = !isUser && "metadata" in message
    ? (message.metadata as { routing?: RouteDecisionMetadata } | null | undefined)?.routing ?? null
    : null;
  const memoryRecall = !isUser && "metadata" in message
    ? (message.metadata as { memory_recall?: { memory_hits: number; message_hits: number } } | null | undefined)?.memory_recall ?? null
    : null;
  const automationActivity = !isUser && "metadata" in message
    ? message.metadata?.automation_activity ?? null
    : null;
  const unverifiedLinks = useMemo<ReadonlySet<string> | undefined>(
    () => citations?.unverified_links?.length ? new Set(citations.unverified_links) : undefined,
    [citations],
  );
  // Numbered source manifest the agent saw at prompt time. The chat UI
  // resolves each inline `[N]` marker in the assistant text to a clickable
  // link/anchor against this map. Persisted on every assistant turn where
  // the agent's `citation_strictness` was not `off`; absent on legacy rows
  // and on turns where the manifest was empty.
  const sourceManifest = useMemo<ReadonlyMap<number, { href: string; label: string }> | undefined>(() => {
    if (!citations?.sources?.length) return undefined;
    return new Map(citations.sources.map((s) => [s.n, { href: s.href, label: s.label }]));
  }, [citations]);

  // Format created_at for the hover timestamp. Streaming bubbles don't have
  // one — we show "now" so the hover affordance is still consistent.
  const createdAt = "created_at" in message ? message.created_at : null;
  const timeLabel = createdAt
    ? new Date(createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : null;

  if (automationActivity) {
    return <AutomationActivityRow activity={automationActivity} />;
  }

  // Compact chip for `run_error` marker rows persisted by the run route
  // when a turn ended in error without producing any assistant content.
  // See ADR-0069.
  if (category === "run_error" && !isUser) {
    const text = typeof parsed === "string"
      ? parsed
      : parsed.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim();
    const detail = text || statusReason;
    return (
      <div className="flex flex-row gap-2 mb-1.5 items-start ml-9">
        <div
          role="status"
          className="flex items-start gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-800 dark:text-rose-200 max-w-full"
        >
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <span className="font-medium">Run failed</span>
            {detail ? <span className="ml-1 opacity-80 break-words">· {detail}</span> : null}
            {timeLabel ? <span className="ml-1 opacity-60">· {timeLabel}</span> : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`group flex ${isUser ? "flex-row-reverse" : "flex-row"} gap-2 mb-1.5 items-end`}>
      {/* Avatar — spacer when not shown to maintain alignment */}
      <div className="shrink-0 w-7">
        {showAvatar && (isUser
          ? <UserAvatar profile={userProfile} />
          : <AgentAvatar config={agentConfig} />
        )}
      </div>

      <div className={`flex flex-col min-w-0 ${!isUser ? "flex-1 items-start" : containsImageAttachment ? "max-w-[calc(100%-2.25rem)] sm:max-w-[92%] md:max-w-[86%] items-end" : "max-w-[calc(100%-2.25rem)] sm:max-w-[75%] items-end"}`}>
        {(timeLabel || messageId) && (
          <div className={`flex items-center gap-1 mb-0.5 px-1 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity ${isUser ? "flex-row-reverse" : ""}`}>
            {timeLabel && (
              <span className="text-[10px] text-fg-faint" aria-hidden>{timeLabel}</span>
            )}
            {messageId && (
              <button
                onClick={copyLink}
                className="text-fg-faint hover:text-fg p-0.5 rounded"
                title="Copy link to this message"
                aria-label="Copy link to this message"
              >
                <Link2 size={11} />
              </button>
            )}
            <button
              onClick={copyMessage}
              className="text-fg-faint hover:text-fg p-0.5 rounded"
              title={copiedMessage ? "Copied" : "Copy message text"}
              aria-label="Copy message text"
            >
              {copiedMessage ? <Check size={11} /> : <Copy size={11} />}
            </button>
            {canRetry && (
              <button
                onClick={handleRetry}
                className="text-fg-faint hover:text-fg p-0.5 rounded"
                title="Resend this prompt as a new turn"
                aria-label="Resend this prompt as a new turn"
              >
                <RotateCcw size={11} />
              </button>
            )}
            {voiceEnabled && !streaming && ttsAbleText.trim() && (
              <button
                onClick={() => void speak()}
                className={`p-0.5 rounded ${audioState === "error" ? "text-rose-500" : "text-fg-faint hover:text-fg"}`}
                title={audioError ?? (audioState === "playing" ? "Pause" : audioState === "loading" ? "Loading…" : "Play voice")}
                aria-label={audioState === "playing" ? "Pause voice" : "Play voice"}
                disabled={audioState === "loading"}
              >
                {audioState === "loading" ? <Loader2 size={11} className="animate-spin" />
                  : audioState === "playing" ? <Pause size={11} />
                  : <Play size={11} />}
              </button>
            )}
          </div>
        )}
        <div
          className={`rounded-2xl ${containsImageAttachment ? "p-1.5" : "px-4 py-3"} text-sm leading-relaxed max-w-full overflow-hidden ${
            isUser ? "glass-bubble-accent text-white rounded-br-sm" : "glass-bubble text-fg rounded-bl-sm"
          }`}
        >
          {attachedActivity && !isUser ? (
            <div className="mb-2 rounded-md border border-border/50 bg-surface-2/50 px-2 py-1.5 text-[11px] text-fg-muted">
              <div className="flex flex-wrap items-center gap-1.5" role="status">
                <span className="font-medium">{AUTOMATION_ACTIVITY_SOURCE[attachedActivity.source_kind].label}</span>
                <span aria-hidden>·</span>
                <span className="truncate" title={attachedActivity.label}>{attachedActivity.label}</span>
                <span aria-hidden>·</span>
                <span>{activityStatus(attachedActivity).copy}</span>
                {attachedActivity.occurrence_count > 1 ? (
                  <span className="opacity-70">· {attachedActivity.occurrence_count} checks</span>
                ) : null}
              </div>
              {attachedActivity.detail ? (
                <details className="mt-1 border-t border-border/40 pt-1">
                  <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-fg-faint">Trigger</summary>
                  <div className="mt-1 whitespace-pre-wrap break-words text-fg-muted">{attachedActivity.detail}</div>
                </details>
              ) : null}
            </div>
          ) : null}
          {typeof parsed === "string" ? (
            isUser ? (
              (() => {
                const trigger = parseTriggerMessage(category, parsed);
                if (trigger) return <TriggerMessageCard data={trigger} />;
                const bridge = parseBridgeContext(parsed);
                if (bridge) return <BridgeMessageCard ctx={bridge} activity={attachedActivity} />;
                const ext = parseExtensionTurn(parsed);
                if (ext) return <ExtensionTurnCard ctx={ext} accent={true} />;
                const ctx = parseCapturedContext(parsed);
                if (ctx) return <CapturedContextCard ctx={ctx} accent={true} />;
                return (
                  <CollapsibleLong accent={true}>
                    <MarkdownContent text={parsed} onInAppLink={handleInAppLink} threadId={threadId} />
                  </CollapsibleLong>
                );
              })()
            ) : (
              <div className="flex flex-col">
                {category && <CategorySourceBadge category={category} />}
                <CollapsibleLong accent={false} streaming={streaming} defaultOpen={isLatest}>
                  <MarkdownContent text={renderedString ?? parsed} streaming={streaming} onInAppLink={handleInAppLink} unverifiedLinks={unverifiedLinks} sourceManifest={sourceManifest} threadId={threadId} />
                </CollapsibleLong>
              </div>
            )
          ) : (
            <div className="flex flex-col gap-1.5">
              {(() => {
                // Bridge messages that carry attachments get persisted as a
                // ContentPart[] whose first text part holds the bracketed
                // [bridge:.] header + body. Detect that case so the user
                // bubble shows the card on top of the media parts instead of
                // a raw bracket dump above them.
                const firstText = isUser && parsed[0]?.type === "text" && typeof parsed[0].text === "string"
                  ? parsed[0].text
                  : null;
                const bridge = firstText ? parseBridgeContext(firstText) : null;
                if (bridge) {
                  return (
                    <>
                      <BridgeMessageCard ctx={bridge} activity={attachedActivity} />
                      {parsed.slice(1).map((part, i) => (
                        <ContentPartView key={i + 1} part={part} isUser={isUser} onInAppLink={handleInAppLink} threadId={threadId} />
                      ))}
                    </>
                  );
                }
                return parsed.map((part, i) => (
                  <ContentPartView key={i} part={part} isUser={isUser} onInAppLink={handleInAppLink} unverifiedLinks={unverifiedLinks} sourceManifest={sourceManifest} threadId={threadId} />
                ));
              })()}
              {streaming && <span className="jarela-stream-caret" aria-hidden="true" />}
            </div>
          )}
          {!isUser && !streaming && "usage" in message && message.usage && (contextWindowTokens ?? message.usage.context_window_tokens) ? (
            <div className="-mx-4 -mb-3 mt-3">
              <ContextUsageBar
                usage={message.usage}
                fallbackContextWindow={contextWindowTokens ?? 0}
              />
            </div>
          ) : null}
        </div>
        {!isUser && !streaming && transcriptStatus && transcriptStatus !== "completed" && (
          <div
            role="status"
            className={`flex items-center gap-1 text-xs px-1 mt-1 ${transcriptStatus === "failed" ? "text-rose-700 dark:text-rose-300" : "text-fg-faint"}`}
          >
            {transcriptStatus === "in_progress" ? <Loader2 size={11} className="animate-spin" />
              : transcriptStatus === "interrupted" ? <Pause size={11} />
              : <AlertTriangle size={11} />}
            <span>{transcriptStatus === "in_progress" ? "Response in progress"
              : transcriptStatus === "interrupted" ? "Response interrupted"
              : "Response failed"}</span>
            {statusReason && <span className="break-words">· {statusReason}</span>}
          </div>
        )}
        {isUser && "status" in message && (message.status === 'pending' || message.status === 'steering') && (
          <span className="flex items-center gap-1 text-xs opacity-50 px-1 self-end">
            {message.status === 'steering' ? <CornerDownRight size={10} /> : <Clock size={10} />}
            {message.status === 'steering' ? "Steering…" : "Sending…"}
          </span>
        )}        {!isUser && !streaming && showToolEvents && "tool_events" in message && Array.isArray(message.tool_events) && message.tool_events.length > 0 && (
          <ToolList events={message.tool_events} />
        )}
        {routingDecision && (
          <RoutingDecisionSummary decision={routingDecision} />
        )}
        {memoryRecall && (
          <MemoryRecallBadge memoryHits={memoryRecall.memory_hits} messageHits={memoryRecall.message_hits} />
        )}
        {citations && Array.isArray(citations.sources) && citations.sources.length > 0 && (
          <ReferencesPanel sources={citations.sources} />
        )}
        {citations && Array.isArray(citations.claims) && citations.claims.length > 0 && (
          <CitationsSummary claims={citations.claims} checkerModel={citations.checker_model ?? ""} />
        )}
        {redactionSummary && redactionSummary.length > 0 && (
          <RedactionShield summary={redactionSummary} />
        )}
        {refs.length > 0 && <RefsFooter refs={refs} />}
      </div>
    </div>
  );
});
