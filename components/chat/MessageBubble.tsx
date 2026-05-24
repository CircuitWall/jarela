"use client";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Bot, ChevronRight, Link as LinkIcon, Link2, Loader2, MessageCircle, Paperclip, Pause, Play, User, Users, X } from "lucide-react";
import type { AgentConfig, Message, UserProfile } from "@/api/types";
import type { ContentPart } from "@/api/types";
import { ToolList } from "@/components/chat/ToolList";
import { useAppContext } from "@/contexts/AppContext";
import { parseHref } from "@/lib/ui/navigate";
import { pushToast } from "@/lib/ui/toasts";

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
    // eslint-disable-next-line jsx-a11y/media-has-caption
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
  const [open, setOpen] = useState(false);
  const hostname = (() => { try { return new URL(ctx.url).hostname; } catch { return ctx.url; } })();
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 text-left min-w-0 ${accent ? "text-white/95 hover:text-white" : "text-fg hover:text-fg-muted"}`}
        aria-expanded={open}
        title={open ? "Hide captured content" : "Show captured content"}
      >
        <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <Paperclip size={12} className="shrink-0" />
        <span className="text-[13px] font-medium truncate min-w-0">{ctx.title || hostname}</span>
      </button>
      <div className={`flex flex-wrap items-center gap-1.5 text-[10px] pl-5 ${accent ? "text-white/75" : "text-fg-faint"}`}>
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
      </div>
      {open && ctx.body && (
        <div className={`mt-1 pt-2 pl-5 border-t ${accent ? "border-white/20" : "border-border/60"}`}>
          <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed opacity-90">{ctx.body}</p>
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
}: {
  children: React.ReactNode;
  threshold?: number;
  accent: boolean;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const check = () => setOverflows(el.scrollHeight > threshold + 24);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [threshold]);

  const collapsed = overflows && !open;

  return (
    <div className="flex flex-col">
      <div
        ref={innerRef}
        className={collapsed ? "relative overflow-hidden" : ""}
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
          <ChevronRight size={10} className={`transition-transform ${open ? "rotate-90" : ""}`} />
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
const MD_REHYPE_PLUGINS: import("unified").PluggableList = [rehypeRaw, [rehypeSanitize, sanitizeSchema]];

type Props = {
  message: Message | { role: "assistant"; content: string; streaming?: boolean };
  agentConfig?: AgentConfig | null;
  userProfile?: UserProfile | null;
  showAvatar?: boolean;
  threadId?: string | null;
  // When false, suppress the inline ToolList for this message. Driven by
  // the chat-panel filter toolbar's `tool_use` toggle.
  showToolEvents?: boolean;
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
interface BridgeContext {
  bridgeId: string;
  chatJid: string;
  chatName: string;
  isGroup: boolean;
  senderJid: string;
  senderName: string;
  body: string;
}

function parseBridgeContext(raw: string): BridgeContext | null {
  if (!raw.startsWith("[bridge:")) return null;
  // Walk the contiguous `[key:value]` prefix line-by-line; stop at the first
  // blank line (dispatcher always separates the header from the body with one).
  const headers: Record<string, string> = {};
  const lines = raw.split("\n");
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") { i++; break; }
    const m = /^\[([a-z_]+):([\s\S]*)\]$/.exec(line);
    if (!m) return null;
    headers[m[1]] = m[2];
  }
  if (!headers.bridge || !headers.chat_jid || !headers.chat_type) return null;
  return {
    bridgeId: headers.bridge,
    chatJid: headers.chat_jid,
    chatName: headers.chat_name || headers.chat_jid,
    isGroup: headers.chat_type === "group",
    senderJid: headers.sender_jid || headers.chat_jid,
    senderName: headers.sender_name || headers.sender_jid || "Unknown",
    body: lines.slice(i).join("\n").trimEnd(),
  };
}

// Compact header card for inbound bridge messages. Shows sender + chat
// context as a single line of metadata above the actual message text, so a
// WhatsApp DM looks like "Alice • DM\n<text>" and a group message looks
// like "Alice in Family Chat • Group\n<text>". Always on the user-bubble
// (accent) side because bridge messages are persisted with role=user.
function BridgeMessageCard({ ctx }: { ctx: BridgeContext }) {
  const showChat = ctx.isGroup && ctx.chatName && ctx.chatName !== ctx.senderName;
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] text-white/85 min-w-0">
        {ctx.isGroup ? <Users size={11} className="shrink-0" /> : <MessageCircle size={11} className="shrink-0" />}
        <span className="font-medium truncate" title={ctx.senderJid}>{ctx.senderName}</span>
        {showChat && (
          <>
            <span className="text-white/55">in</span>
            <span className="truncate" title={ctx.chatJid}>{ctx.chatName}</span>
          </>
        )}
        <span className="px-1.5 py-0.5 rounded-full bg-white/15 text-[9.5px] uppercase tracking-wide shrink-0">
          {ctx.isGroup ? "group" : "dm"}
        </span>
      </div>
      {ctx.body ? (
        <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{ctx.body}</p>
      ) : (
        <p className="text-[12px] italic text-white/65">(empty message)</p>
      )}
    </div>
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
    parseError = e instanceof Error ? e.message : String(e);
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

function MarkdownContent({ text, streaming, onInAppLink }: { text: string; streaming?: boolean; onInAppLink?: (href: string) => void }) {  return (
    <div className="prose prose-invert prose-sm max-w-none jarela-rich">
      <ReactMarkdown
        remarkPlugins={MD_REMARK_PLUGINS}
        rehypePlugins={MD_REHYPE_PLUGINS}
        components={{
          a({ href, children, ...rest }) {
            const parsed = href ? parseHref(href) : undefined;
            // Inline audio: any link to a local /api/v1/files/*.{wav,mp3,ogg,webm,m4a}
            // becomes a native <audio controls> player. The original anchor
            // text is dropped — the player IS the answer. An `?autoplay=1`
            // query string lets the agent (via generate_voice) ask the
            // browser to start playback immediately.
            if (href && /^\/api\/v1\/files\/[^?#]+\.(wav|mp3|ogg|webm|m4a)(\?|#|$)/i.test(href)) {
              return <InlineAudio href={href} />;
            }
            const inApp = !!parsed && !parsed.external && (!!parsed.tab || !!parsed.hash);
            if (inApp && href && onInAppLink) {
              return (
                <a
                  {...rest}
                  href={href}
                  onClick={(e) => { e.preventDefault(); onInAppLink(href); }}
                >
                  {children}
                </a>
              );
            }
            return (
              <a
                {...rest}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {children}
              </a>
            );
          },
          code({ className, children }) {
            const match = /language-(\w+)/.exec(className ?? "");
            const code = String(children).replace(/\n$/, "");
            if (match?.[1] === "map") return <MapEmbed payload={code} />;
            return match ? (
              <SyntaxHighlighter
                style={oneDark}
                language={match[1]}
                PreTag="div"
                wrapLongLines
                customStyle={{ maxWidth: "100%", overflowX: "auto" }}
              >
                {code}
              </SyntaxHighlighter>
            ) : (
              <code className="bg-surface-2 px-1 rounded text-fg-muted break-all">{code}</code>
            );
          },
          img({ src, alt }) {
            return <ResilientMarkdownImage src={src} alt={alt} />;
          },
        }}
      >
        {text}
      </ReactMarkdown>
      {streaming && (
        <span className="inline-flex items-center align-middle ml-1" aria-label="typing">
          <span className="jarela-typing-dot" />
          <span className="jarela-typing-dot" />
          <span className="jarela-typing-dot" />
        </span>
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
        <ChevronRight size={10} className={`transition-transform ${open ? "rotate-90" : ""}`} />
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

function ContentPartView({ part, isUser, onInAppLink }: { part: ContentPart; isUser: boolean; onInAppLink?: (href: string) => void }) {
  if (part.type === "text") {
    return isUser
      ? <p className="whitespace-pre-wrap">{part.text}</p>
      : <MarkdownContent text={part.text} onInAppLink={onInAppLink} />;
  }
  if (part.type === "image") {
    return <ClickableImage media_type={part.media_type} data={part.data} />;
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

// Image attachment — thumbnail in the bubble, click for a full-screen lightbox.
function ClickableImage({ media_type, data }: { media_type: string; data: string }) {
  const [open, setOpen] = useState(false);
  const src = `data:${media_type};base64,${data}`;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="attached image"
        onClick={() => setOpen(true)}
        className="max-w-full rounded-xl mt-1 border border-border/40 cursor-zoom-in hover:border-fg-faint transition-colors"
        style={{ maxHeight: "400px", objectFit: "contain" }}
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

// Memoized: while a run streams, ChatView re-renders on every text_delta to
// update the live streaming bubble. Without React.memo, every persisted
// MessageBubble re-renders too — for a 50-message thread that's 50
// reconciliations per character. Props are pure data (no callbacks), and
// `messages` array preserves identity for unchanged rows after the
// `concat` in handleDone, so default shallow-equality is enough.
export const MessageBubble = memo(function MessageBubble({ message, agentConfig, userProfile, showAvatar = true, threadId = null, showToolEvents = true }: Props) {
  const { dispatch } = useAppContext();
  const isUser = message.role === "user";
  const streaming = "streaming" in message && message.streaming;
  const parsed = parseContent(message.content);
  const messageId = "id" in message ? message.id : null;

  const handleInAppLink = useCallback((href: string) => {
    const p = parseHref(href);
    if (p.tab) {
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
        catch (err) { setAudioError(err instanceof Error ? err.message : String(err)); setAudioState("error"); }
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
      setAudioError(err instanceof Error ? err.message : String(err));
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
  }

  // Format created_at for the hover timestamp. Streaming bubbles don't have
  // one — we show "now" so the hover affordance is still consistent.
  const createdAt = "created_at" in message ? message.created_at : null;
  const timeLabel = createdAt
    ? new Date(createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <div className={`group flex ${isUser ? "flex-row-reverse" : "flex-row"} gap-2 mb-1.5 items-end`}>
      {/* Avatar — spacer when not shown to maintain alignment */}
      <div className="shrink-0 w-7">
        {showAvatar && (isUser
          ? <UserAvatar profile={userProfile} />
          : <AgentAvatar config={agentConfig} />
        )}
      </div>

      <div className={`flex flex-col max-w-[88%] sm:max-w-[75%] min-w-0 ${isUser ? "items-end" : "items-start"}`}>
        {(timeLabel || messageId) && (
          <div className={`flex items-center gap-1 mb-0.5 px-1 opacity-0 group-hover:opacity-100 transition-opacity ${isUser ? "flex-row-reverse" : ""}`}>
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
          className={`rounded-2xl px-4 py-3 text-sm leading-relaxed max-w-full overflow-hidden ${
            isUser ? "glass-bubble-accent text-white rounded-br-sm" : "glass-bubble text-fg rounded-bl-sm"
          }`}
        >
          {typeof parsed === "string" ? (
            isUser ? (
              (() => {
                const bridge = parseBridgeContext(parsed);
                if (bridge) return <BridgeMessageCard ctx={bridge} />;
                const ctx = parseCapturedContext(parsed);
                if (ctx) return <CapturedContextCard ctx={ctx} accent={true} />;
                return (
                  <CollapsibleLong accent={true}>
                    <p className="whitespace-pre-wrap">{parsed}</p>
                  </CollapsibleLong>
                );
              })()
            ) : (
              <CollapsibleLong accent={false}>
                <MarkdownContent text={renderedString ?? parsed} streaming={streaming} onInAppLink={handleInAppLink} />
              </CollapsibleLong>
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
                  <ContentPartView key={i} part={part} isUser={isUser} onInAppLink={handleInAppLink} />
                ));
              })()}
              {streaming && (
        <span className="inline-flex items-center align-middle ml-1" aria-label="typing">
          <span className="jarela-typing-dot" />
          <span className="jarela-typing-dot" />
          <span className="jarela-typing-dot" />
        </span>
      )}
            </div>
          )}
        </div>
        {!isUser && !streaming && showToolEvents && "tool_events" in message && Array.isArray(message.tool_events) && message.tool_events.length > 0 && (
          <ToolList events={message.tool_events} />
        )}
        {refs.length > 0 && <RefsFooter refs={refs} />}
      </div>
    </div>
  );
});
