"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import "highlight.js/styles/github-dark.css";
import { AlertTriangle, Bot, Check, Clock, Copy, Eye, EyeOff, Globe, Link as LinkIcon, Link2, Loader2, MessageCircle, Paperclip, Pause, Play, RotateCcw, ShieldCheck, User, Users, X, Zap } from "lucide-react";
import type { AgentConfig, Message, RouteDecisionMetadata, UserProfile } from "@/api/types";
import type { ContentPart } from "@/api/types";
import { ToolList } from "@/components/chat/ToolList";
import { ContextUsageBar } from "@/components/chat/ContextUsageBar";
import { CountdownRing } from "@/components/chat/CountdownRing";
import { CollapseChevron } from "@/components/ui/CollapseChevron";
import { MetaRow } from "@/components/ui/MetaRow";
import { useAppContext } from "@/contexts/AppContext";
import { parseHref } from "@/lib/ui/navigate";
import { formatRoutingDecisionSummary, formatRoutingDuration, humanizeRouteClass } from "@/lib/ui/routing-decision";
import { pushToast } from "@/lib/ui/toasts";
import { parseBridgePrompt, type BridgePromptContext } from "@/lib/bridges/message-role";
import { parseExtensionTurn, type ExtensionTurnContext } from "@/lib/api/extension-turn-prompt";
import { errorMessage } from "@/lib/utils/error";

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

// Mid-stream guard for the agent's optional trailing
// ```jarela-references` fence. The server-side parser folds that block
// into the citation manifest and strips it from the persisted body, but
// during streaming the in-flight buffer still contains it. Cut from the
// opening fence onward so the user never sees raw JSON flash on screen.
// Once the closing fence has arrived the body is identical to what the
// server will persist either way; cutting from the open is the simple
// path that handles partial-block and complete-block cases uniformly.
function stripDeclaredReferencesFence(text: string): string {
  const idx = text.indexOf("```jarela-references");
  if (idx < 0) return text;
  return text.slice(0, idx).trimEnd();
}

// Tracks which TTS clips have started auto-playing this session so a clip
// only autoplays once. Re-renders of the same <audio> (message refetched,
// scroll into view, list re-render) won't trigger a replay. Keyed by the
// full href (including any `?autoplay=1`). Cleared on hard refresh — exactly
// the "session" semantics we want.
const playedAutoplayHrefs = new Set<string>();

function InlineAudio({ href }: { href: string }) {
  // Decide autoPlay at mount time: opt in only if the URL asked for it AND
  // we haven't already auto-played this exact clip in this session.
  const wantsAuto = /[?&]autoplay=1\b/.test(href);
  const [auto] = useState(() => wantsAuto && !playedAutoplayHrefs.has(href));
  return (
    <audio
      controls
      preload="metadata"
      autoPlay={auto}
      src={href}
      className="my-2 w-full max-w-md"
      onPlay={() => {
        if (wantsAuto) playedAutoplayHrefs.add(href);
      }}
    />
  );
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

// Small source-channel badge shown at the top of assistant bubbles that
// were triggered by automation (bridge reply, scheduled task reply, etc.).
// Lets the user tell at a glance which automation channel generated the
// response without needing to scroll up to the corresponding user bubble.
const CATEGORY_BADGE: Record<string, { label: string; Icon: React.ElementType; cls: string }> = {
  scheduled_task: { label: "Scheduled", Icon: Clock,          cls: "text-violet-400/90 border-violet-500/30 bg-violet-950/30" },
  watcher:        { label: "Watcher",   Icon: Eye,            cls: "text-amber-400/90  border-amber-500/30  bg-amber-950/30" },
  bridge:         { label: "Bridge",    Icon: MessageCircle,  cls: "text-sky-400/90    border-sky-500/30    bg-sky-950/30" },
  page_capture:   { label: "Capture",   Icon: Globe,          cls: "text-teal-400/90   border-teal-500/30   bg-teal-950/30" },
  extension:      { label: "Extension", Icon: Zap,            cls: "text-indigo-400/90 border-indigo-500/30 bg-indigo-950/30" },
  synthetic:      { label: "System",    Icon: Bot,            cls: "text-fg-faint      border-border/40     bg-surface-2" },
};

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

// Same chip used on the user-bubble side of an automated turn (extension,
// bridge, capture, scheduled task, watcher). Bare label — no "reply"
// suffix — so the chip reads as a source tag, not a response indicator.
function UserCategoryChip({ category }: { category: string }) {
  const def = CATEGORY_BADGE[category];
  if (!def) return null;
  const { label, Icon, cls } = def;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[9.5px] font-medium shrink-0 ${cls}`}>
      <Icon size={9} className="shrink-0" />
      <span>{label}</span>
    </span>
  );
}

// Compact disclosure used inside every automation-turn card so each
// section (instruction, context, captured content, change diff) has the
// same chevron + label affordance.
function CollapsibleSection({
  label,
  defaultOpen,
  accent,
  hint,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  accent: boolean;
  hint?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 text-left text-[10.5px] ${accent ? "text-white/75 hover:text-white/95" : "text-fg-muted hover:text-fg"}`}
        aria-expanded={open}
      >
        <CollapseChevron open={open} size={11} />
        <span className="uppercase tracking-wide">{label}</span>
        {hint && <span className={`ml-1 normal-case ${accent ? "text-white/55" : "text-fg-faint"}`}>{hint}</span>}
      </button>
      {open && <div className="pl-4 min-w-0">{children}</div>}
    </div>
  );
}

// Shared skeleton for every automation-turn user bubble. Top row is a
// small category chip + icon + title; an optional chip row holds metadata
// pills (host, selector, dm/group); the body is a list of collapsible
// sections. This keeps extension/bridge/capture/trigger bubbles visually
// consistent so the operator can scan an automation thread quickly.
function StructuredTurnCard({
  categoryKey,
  Icon,
  title,
  titleTooltip,
  chips,
  sections,
  accent,
}: {
  categoryKey: string | null;
  Icon: React.ElementType;
  title: string;
  titleTooltip?: string;
  chips?: ReactNode;
  sections: Array<{ label: string; content: ReactNode; defaultOpen?: boolean; hint?: string }>;
  accent: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
        {categoryKey && <UserCategoryChip category={categoryKey} />}
        <Icon size={12} className={`shrink-0 ${accent ? "text-white/85" : "text-fg-muted"}`} />
        <span
          className={`text-[13px] font-medium truncate min-w-0 ${accent ? "text-white/95" : "text-fg"}`}
          title={titleTooltip}
        >
          {title}
        </span>
      </div>
      {chips && (
        <div className={`flex flex-wrap items-center gap-1.5 text-[10px] ${accent ? "text-white/75" : "text-fg-faint"}`}>
          {chips}
        </div>
      )}
      {sections.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {sections.map((s, i) => (
            <CollapsibleSection
              key={i}
              label={s.label}
              defaultOpen={s.defaultOpen}
              hint={s.hint}
              accent={accent}
            >
              {s.content}
            </CollapsibleSection>
          ))}
        </div>
      )}
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

// Sanitizer schema = GitHub default + extras the agent is told it can use.
// Anything not listed here gets stripped (scripts, event handlers, javascript: URLs).
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "details", "summary", "mark", "kbd", "sub", "sup", "abbr", "small",
    "aside", "figure", "figcaption", "dl", "dt", "dd",
    "audio", "source",
  ],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    "*": [...((defaultSchema.attributes ?? {})["*"] ?? []), "className", "title"],
    aside: ["className"],
    abbr: ["title"],
    details: ["open"],
    audio: ["src", "controls", "preload", "loop", "autoplay", "muted"],
    source: ["src", "type"],
  },
};

// Module-scope plugin arrays — passing fresh array literals to ReactMarkdown
// on every render of MarkdownContent forced react-markdown's internal
// useMemo() inputs to differ each time, defeating its plugin-pipeline
// memoization. Hoisting these makes the references stable across renders.
const MD_REMARK_PLUGINS = [remarkGfm];
// rehype-highlight runs after rehype-raw (so any raw HTML <code> blocks are
// also highlighted) and before rehype-sanitize (so the spans/classes it adds
// pass through the sanitizer's allow-list rather than being stripped).
const MD_REHYPE_PLUGINS: import("unified").PluggableList = [
  rehypeRaw,
  [rehypeHighlight, { detect: true, ignoreMissing: true }],
  [rehypeSanitize, sanitizeSchema],
];

function reactChildrenToText(children: ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(reactChildrenToText).join("");
  if (typeof children === "object" && "props" in (children as object)) {
    return reactChildrenToText((children as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

type Props = {
  message: Message | { role: "assistant"; content: string; streaming?: boolean };
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
  onRetry?: (text: string, attachments: ContentPart[]) => void;
  // Number of tool calls currently in flight for the streaming run. Drives
  // the CountdownRing's adaptive pause so the wall-clock indicator mirrors
  // run-registry's effective-elapsed semantics (tool time is excluded).
  inflightToolCount?: number;
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
function BridgeMessageCard({ ctx }: { ctx: BridgePromptContext }) {
  const showChat = ctx.isGroup && ctx.chatName && ctx.chatName !== ctx.senderName;
  const title = showChat ? `${ctx.senderName} in ${ctx.chatName}` : ctx.senderName;
  const Icon = ctx.isGroup ? Users : MessageCircle;
  const chips = (
    <span className="px-1.5 py-0.5 rounded-full bg-white/15 text-[9.5px] uppercase tracking-wide shrink-0">
      {ctx.isGroup ? "group" : "dm"}
    </span>
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

// Markdown image renderer with a one-time automatic retry. If both attempts
// fail (common on transient local-network/SW races), show a compact fallback
// with explicit actions instead of a broken image icon.
function ResilientMarkdownImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const [retryNonce, setRetryNonce] = useState(0);
  const [failed, setFailed] = useState(false);

  const normalizedSrc = typeof src === "string" ? src : src instanceof Blob ? URL.createObjectURL(src) : "";
  const effectiveSrc = normalizedSrc
    ? `${normalizedSrc}${normalizedSrc.includes("?") ? "&" : "?"}retry=${retryNonce}`
    : "";

  if (!normalizedSrc) {
    return (
      <div className="my-2 px-3 py-2 rounded border border-rose-800/60 bg-rose-950/30 text-xs text-rose-700 dark:text-rose-300">
        Invalid image URL in markdown.
      </div>
    );
  }

  if (failed) {
    return (
      <div className="my-2 px-3 py-2 rounded border border-amber-700/50 bg-amber-900/20 text-xs text-amber-300">
        <div>Image failed to load.</div>
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            className="px-2 py-1 rounded border border-amber-500/60 hover:bg-amber-900/30"
            onClick={() => {
              setFailed(false);
              setRetryNonce((n) => n + 1);
            }}
          >
            Retry
          </button>
          <a
            href={normalizedSrc}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-dotted hover:decoration-solid break-all"
          >
            Open image
          </a>
        </div>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={effectiveSrc}
      alt={alt ?? "image"}
      loading="lazy"
      className="rounded-lg border border-border/50"
      onError={() => {
        if (retryNonce === 0) {
          setRetryNonce(1);
          return;
        }
        setFailed(true);
      }}
    />
  );
}

// Renders a Google Maps Embed inside an iframe whose src points at our
// server-side proxy (/api/v1/maps/embed). The proxy injects the API key so
// it never appears in chat HTML. Triggered by ```map fenced blocks emitted
// by the agent — see PRESENTATION_CTX in lib/agents/run-thread.ts.
function MapEmbed({ payload }: { payload: string }) {
  const [retryNonce, setRetryNonce] = useState(0);
  const [failed, setFailed] = useState(false);
  let params: URLSearchParams | null = null;
  let parseError: string | null = null;
  try {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    const sp = new URLSearchParams();
    for (const k of ["q", "center", "zoom", "origin", "destination", "search", "mode"] as const) {
      const v = obj[k];
      if (typeof v === "string" && v.length > 0) sp.set(k, v);
      else if (typeof v === "number") sp.set(k, String(v));
    }
    if ([...sp.keys()].length === 0) parseError = "no recognized fields (q / center / origin+destination / search)";
    else params = sp;
  } catch (e) {
    parseError = errorMessage(e);
  }

  if (!params) {
    return (
      <div className="my-2 px-3 py-2 rounded border border-rose-800/60 bg-rose-950/30 text-xs text-rose-700 dark:text-rose-300">
        Invalid map block: {parseError}
      </div>
    );
  }
  const src = `/api/v1/maps/embed?${params.toString()}${retryNonce > 0 ? `&retry=${retryNonce}` : ""}`;

  if (failed) {
    const q = params.get("q") ?? params.get("search") ?? params.get("center") ?? "";
    const direct = q
      ? `https://www.google.com/maps?q=${encodeURIComponent(q)}`
      : "https://www.google.com/maps";
    return (
      <div className="my-2 px-3 py-2 rounded border border-amber-700/50 bg-amber-900/20 text-xs text-amber-300">
        <div>Map failed to load.</div>
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            className="px-2 py-1 rounded border border-amber-500/60 hover:bg-amber-900/30"
            onClick={() => {
              setFailed(false);
              setRetryNonce((n) => n + 1);
            }}
          >
            Retry
          </button>
          <a
            href={direct}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-dotted hover:decoration-solid"
          >
            Open in Google Maps
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="my-2 rounded overflow-hidden border border-border bg-surface-2">
      <iframe
        src={src}
        title="Map"
        width="100%"
        height="320"
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        allowFullScreen
        style={{ border: 0, display: "block" }}
        onError={() => {
          if (retryNonce === 0) {
            setRetryNonce(1);
            return;
          }
          setFailed(true);
        }}
      />
    </div>
  );
}

// Memoized: this component appears under every assistant bubble and during
// streaming gets re-rendered on every rAF flush. The inner ReactMarkdown
// pipeline (remark + rehype passes, syntax highlighting via rehypeHighlight,
// custom <a> / <code> renderers) is the expensive part — re-running it
// against unchanged text on every parent render shows up as jank on long
// threads. With memo, only the in-flight bubble re-renders during streaming;
// persisted siblings sit idle.
const MarkdownContent = memo(function MarkdownContent({ text, streaming, onInAppLink, unverifiedLinks, sourceManifest, inflightToolCount = 0 }: { text: string; streaming?: boolean; onInAppLink?: (href: string) => void; unverifiedLinks?: ReadonlySet<string>; sourceManifest?: ReadonlyMap<number, { href: string; label: string }>; inflightToolCount?: number }) {
  // Inline-citation pre-processor. The agent writes `[3]` markers in-prose;
  // we resolve each to a markdown link `[3](href)` BEFORE react-markdown
  // parses the string so the existing <a> renderer below picks it up with
  // no special-casing. Markers whose number isn't in the manifest are
  // left untouched (they'll show as plain `[3]` text) so an invented
  // number is visibly un-linked rather than silently mis-routed.
  const renderedText = useMemo(() => {
    if (!sourceManifest || sourceManifest.size === 0) return text;
    return text.replace(/(?<!\])\[(\d+)\]/g, (match, raw: string) => {
      const entry = sourceManifest.get(parseInt(raw, 10));
      return entry ? `[${raw}](${entry.href})` : match;
    });
  }, [text, sourceManifest]);
  return (
    <div className="prose prose-invert prose-sm max-w-none jarela-rich min-w-0">
      <ReactMarkdown
        remarkPlugins={MD_REMARK_PLUGINS}
        rehypePlugins={MD_REHYPE_PLUGINS}
        components={{
          a({ href, children, ...rest }) {
            const parsed = href ? parseHref(href) : undefined;
            const isUnverified = !!(href && unverifiedLinks?.has(href));
            // Detect citation markers: link text is literally `[N]` where N
            // is a positive integer. These are rendered as small superscript
            // chips (Wikipedia-style) so they're scannable as citations and
            // distinct from ordinary inline links.
            const isCitationMarker =
              Array.isArray(children) && children.length === 1
                ? typeof children[0] === "string" && /^\[\d+\]$/.test(children[0])
                : typeof children === "string" && /^\[\d+\]$/.test(children);
            const citationText = isCitationMarker
              ? (Array.isArray(children) ? (children[0] as string) : (children as string))
              : null;
            // Inline audio: any link to a local /api/v1/files/*.{wav,mp3,ogg,webm,m4a}
            // becomes a native <audio controls> player. The original anchor
            // text is dropped — the player IS the answer. An `?autoplay=1`
            // query string lets the agent (via generate_voice) ask the
            // browser to start playback immediately.
            if (href && /^\/api\/v1\/files\/[^?#]+\.(wav|mp3|ogg|webm|m4a)(\?|#|$)/i.test(href)) {
              return <InlineAudio href={href} />;
            }
            const inApp = !!parsed && !parsed.external && (!!parsed.tab || !!parsed.hash || (!!parsed.thread && !!parsed.agent));
            const unverifiedCls = isUnverified ? "decoration-warn decoration-wavy underline-offset-2" : "";
            const unverifiedTitle = isUnverified ? "Agent did not visit this source in this conversation — the citation may be invented." : undefined;
            // Citation-marker rendering: superscript chip with a tooltip
            // showing the source label so the user can preview what the
            // marker points to without clicking. The href is still active
            // (jumps to anchor for #msg-… or opens external for URLs).
            if (isCitationMarker && href) {
              const markerNum = parseInt(citationText!.replace(/[\[\]]/g, ""), 10);
              const entry = Number.isFinite(markerNum) ? sourceManifest?.get(markerNum) : undefined;
              const title = entry?.label ?? unverifiedTitle ?? href;
              const isAnchor = href.startsWith("#");
              return (
                <a
                  {...rest}
                  href={href}
                  target={isAnchor || inApp ? undefined : "_blank"}
                  rel={isAnchor || inApp ? undefined : "noopener noreferrer"}
                  title={title}
                  onClick={inApp && onInAppLink ? (e) => { e.preventDefault(); onInAppLink(href); } : undefined}
                  className="jarela-citation"
                >
                  {citationText}
                </a>
              );
            }
            if (inApp && href && onInAppLink) {
              return (
                <a
                  {...rest}
                  href={href}
                  title={unverifiedTitle ?? rest.title}
                  className={`${rest.className ?? ""} ${unverifiedCls}`.trim()}
                  onClick={(e) => { e.preventDefault(); onInAppLink(href); }}
                >
                  {children}
                  {isUnverified && <sup className="text-warn ml-0.5" aria-label="unverified citation">⚠</sup>}
                </a>
              );
            }
            return (
              <a
                {...rest}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                title={unverifiedTitle ?? rest.title}
                className={`${rest.className ?? ""} ${unverifiedCls}`.trim()}
              >
                {children}
                {isUnverified && <sup className="text-warn ml-0.5" aria-label="unverified citation">⚠</sup>}
              </a>
            );
          },
          pre({ children }) {
            // CodeFence renders its own <pre>, so collapse react-markdown's
            // outer wrapper to avoid <pre><pre>...</pre></pre>.
            return <>{children}</>;
          },
          code({ className, children }) {
            const match = /language-(\w+)/.exec(className ?? "");
            if (match?.[1] === "map") {
              return <MapEmbed payload={reactChildrenToText(children).replace(/\n$/, "")} />;
            }
            return match ? (
              <CodeFence language={match[1]} className={className ?? ""}>{children}</CodeFence>
            ) : (
              <code className="bg-surface-2 px-1 rounded text-fg-muted break-all">{children}</code>
            );
          },
          img({ src, alt }) {
            return <ResilientMarkdownImage src={src} alt={alt} />;
          },
        }}
      >
        {renderedText}
      </ReactMarkdown>
      {streaming && (        <span className="inline-flex items-center align-middle ml-1">
          <CountdownRing inflightToolCount={inflightToolCount} />
        </span>
      )}
    </div>
  );
});

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

function CodeFence({ language, className, children }: { language: string; className: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const codeText = useMemo(() => reactChildrenToText(children).replace(/\n$/, ""), [children]);

  const copyCode = useCallback(() => {
    void navigator.clipboard.writeText(codeText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(console.error);
  }, [codeText]);

  // rehype-highlight already populated `className` with `hljs language-X`
  // plus per-token spans inside `children`. The `hljs` class drives styling
  // from the imported github-dark theme.
  return (
    <div className="relative my-2 rounded-md overflow-hidden border border-border/60">
      <div className="flex items-center justify-between px-2 py-1 text-[10px] bg-surface-3 text-fg-faint uppercase tracking-wide">
        <span>{language}</span>
        <button
          onClick={copyCode}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border/60 bg-surface-2 text-fg-muted hover:text-fg transition-colors"
          title="Copy code"
          aria-label="Copy code"
        >
          {copied ? <Check size={10} /> : <Copy size={10} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="m-0 p-3 text-xs leading-relaxed overflow-x-auto bg-[#0d1117]">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

function ContentPartView({ part, isUser, onInAppLink, unverifiedLinks, sourceManifest }: { part: ContentPart; isUser: boolean; onInAppLink?: (href: string) => void; unverifiedLinks?: ReadonlySet<string>; sourceManifest?: ReadonlyMap<number, { href: string; label: string }> }) {
  if (part.type === "text") {
    return <MarkdownContent text={part.text} onInAppLink={onInAppLink} unverifiedLinks={unverifiedLinks} sourceManifest={sourceManifest} />;
  }
  if (part.type === "image") {
    return <ClickableImage src={`data:${part.media_type};base64,${part.data}`} />;
  }
  if (part.type === "image_ref") {
    // Ref-based image — server-hosted at /api/v1/files/[name]. See ADR-0065.
    return <ClickableImage src={`/api/v1/files/${encodeURIComponent(part.name)}`} />;
  }
  // File attachment — render an inline player for audio/video so voice
  // notes and short clips from the WhatsApp bridge are usable in-bubble.
  // Other file types still fall through to a download/open-in-new-tab link.
  const file = part as ContentPart & { type: "file"; name: string; media_type: string; data: string };
  const dataUrl = `data:${file.media_type};base64,${file.data}`;
  // For text files our data field is plain text, not base64. Detect and wrap.
  const href = /^text\/|^application\/json$/.test(file.media_type)
    ? `data:${file.media_type};charset=utf-8,${encodeURIComponent(file.data)}`
    : dataUrl;
  if (file.media_type.startsWith("audio/")) {
    return (
      <div className="mt-1 max-w-md">
        {/* Native controls keep play/pause/seek consistent with the OS;
            the filename hint below disambiguates voice-note vs file. */}
        <audio controls className="w-full" src={dataUrl} />
        <div className="mt-0.5 text-[10px] text-fg-faint truncate">{file.name}</div>
      </div>
    );
  }
  if (file.media_type.startsWith("video/")) {
    return (
      <div className="mt-1 max-w-md">
        <video
          controls
          playsInline
          className="w-full rounded-xl border border-border/40"
          style={{ maxHeight: "400px" }}
          src={dataUrl}
        />
        <div className="mt-0.5 text-[10px] text-fg-faint truncate">{file.name}</div>
      </div>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 mt-1 rounded-lg border border-border/60 bg-surface-3/60 hover:bg-surface-3 hover:border-border text-[11px] text-fg-muted transition-colors"
      title="Open in new tab"
    >
      <Paperclip size={11} className="text-fg-faint shrink-0" />
      <span className="truncate max-w-[200px]">{file.name}</span>
    </a>
  );
}

function hasImageAttachment(content: string | ContentPart[]): boolean {
  return Array.isArray(content) && content.some((part) => part.type === "image" || part.type === "image_ref");
}

// Image attachment — thumbnail in the bubble, click for a full-screen lightbox.
// Accepts either a `data:` URL (inline base64) or a `/api/v1/files/[name]`
// URL (disk-hosted ref, see ADR-0065). Both render identically.
function ClickableImage({ src }: { src: string }) {
  const [open, setOpen] = useState(false);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="attached image"
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
          }
        }}
        onClick={() => setOpen(true)}
        className="block w-full max-w-full rounded-xl mt-1 border border-border/40 cursor-zoom-in hover:border-fg-faint transition-colors"
        style={{
          width: naturalSize ? `min(100%, ${naturalSize.width}px)` : "100%",
          maxHeight: naturalSize ? `min(82dvh, ${naturalSize.height}px)` : "82dvh",
          objectFit: "contain",
        }}
      />
      {open && (
        <div
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-[60] bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 cursor-zoom-out animate-in fade-in"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt="attached image"
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); }}
            className="absolute top-4 right-4 p-2 rounded-full bg-black/40 hover:bg-black/60 text-white"
            aria-label="Close"
          >
            <X size={16} />
          </button>
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-4 right-4 px-3 py-1.5 rounded-md bg-black/40 hover:bg-black/60 text-white text-xs"
          >
            Open in new tab
          </a>
        </div>
      )}
    </>
  );
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
export const MessageBubble = memo(function MessageBubble({ message, agentConfig, userProfile, showAvatar = true, threadId = null, showToolEvents = true, contextWindowTokens = null, isLatest = false, onRetry, inflightToolCount = 0 }: Props) {
  const { dispatch } = useAppContext();
  const isUser = message.role === "user";
  const streaming = "streaming" in message && message.streaming;
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
  const canRetry = isUser && !category && !!onRetry && !streaming;
  const handleRetry = useCallback(() => {
    if (!onRetry) return;
    if (typeof parsed === "string") {
      onRetry(parsed, []);
      return;
    }
    let text = "";
    const atts: ContentPart[] = [];
    for (const part of parsed) {
      if (part.type === "text" && !text) text = part.text;
      else atts.push(part);
    }
    onRetry(text, atts);
  }, [onRetry, parsed]);

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

  // Compact chip for `run_error` marker rows persisted by the run route
  // when a turn ended in error without producing any assistant content.
  // See ADR-0069.
  if (category === "run_error" && !isUser) {
    const text = typeof parsed === "string"
      ? parsed
      : parsed.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim();
    return (
      <div className="flex flex-row gap-2 mb-1.5 items-start ml-9">
        <div
          role="status"
          className="flex items-start gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-800 dark:text-rose-200 max-w-full"
        >
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <span className="font-medium">Run failed</span>
            {text ? <span className="ml-1 opacity-80 break-words">— {text}</span> : null}
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

      <div className={`flex flex-col min-w-0 ${containsImageAttachment ? "max-w-[calc(100%-2.25rem)] sm:max-w-[92%] md:max-w-[86%]" : "max-w-[88%] sm:max-w-[75%]"} ${isUser ? "items-end" : "items-start"}`}>
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
          {typeof parsed === "string" ? (
            isUser ? (
              (() => {
                const trigger = parseTriggerMessage(category, parsed);
                if (trigger) return <TriggerMessageCard data={trigger} />;
                const bridge = parseBridgeContext(parsed);
                if (bridge) return <BridgeMessageCard ctx={bridge} />;
                const ext = parseExtensionTurn(parsed);
                if (ext) return <ExtensionTurnCard ctx={ext} accent={true} />;
                const ctx = parseCapturedContext(parsed);
                if (ctx) return <CapturedContextCard ctx={ctx} accent={true} />;
                return (
                  <CollapsibleLong accent={true}>
                    <MarkdownContent text={parsed} onInAppLink={handleInAppLink} />
                  </CollapsibleLong>
                );
              })()
            ) : (
              <div className="flex flex-col">
                {category && <CategorySourceBadge category={category} />}
                <CollapsibleLong accent={false} streaming={streaming} defaultOpen={isLatest}>
                  <MarkdownContent text={renderedString ?? parsed} streaming={streaming} onInAppLink={handleInAppLink} unverifiedLinks={unverifiedLinks} sourceManifest={sourceManifest} inflightToolCount={inflightToolCount} />
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
                      <BridgeMessageCard ctx={bridge} />
                      {parsed.slice(1).map((part, i) => (
                        <ContentPartView key={i + 1} part={part} isUser={isUser} onInAppLink={handleInAppLink} />
                      ))}
                    </>
                  );
                }
                return parsed.map((part, i) => (
                  <ContentPartView key={i} part={part} isUser={isUser} onInAppLink={handleInAppLink} unverifiedLinks={unverifiedLinks} sourceManifest={sourceManifest} />
                ));
              })()}
              {streaming && (
        <span className="inline-flex items-center align-middle ml-1">
          <CountdownRing inflightToolCount={inflightToolCount} />
        </span>
      )}
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
        {isUser && "status" in message && message.status === 'pending' && (
          <span className="flex items-center gap-1 text-xs opacity-50 px-1 self-end">
            <Clock size={10} />
            Sending…
          </span>
        )}
        {!isUser && !streaming && showToolEvents && "tool_events" in message && Array.isArray(message.tool_events) && message.tool_events.length > 0 && (
          <ToolList events={message.tool_events} />
        )}
        {routingDecision && (
          <RoutingDecisionSummary decision={routingDecision} />
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
