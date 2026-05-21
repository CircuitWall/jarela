"use client";
import { memo, useCallback, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Bot, ChevronRight, Link as LinkIcon, Link2, Paperclip, User, X } from "lucide-react";
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

// Sanitizer schema = GitHub default + extras the agent is told it can use.
// Anything not listed here gets stripped (scripts, event handlers, javascript: URLs).
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "details", "summary", "mark", "kbd", "sub", "sup", "abbr", "small",
    "aside", "figure", "figcaption", "dl", "dt", "dd",
  ],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    "*": [...((defaultSchema.attributes ?? {})["*"] ?? []), "className", "title"],
    aside: ["className"],
    abbr: ["title"],
    details: ["open"],
  },
};

type Props = {
  message: Message | { role: "assistant"; content: string; streaming?: boolean };
  agentConfig?: AgentConfig | null;
  userProfile?: UserProfile | null;
  showAvatar?: boolean;
  threadId?: string | null;
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
function ResilientMarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [retryNonce, setRetryNonce] = useState(0);
  const [failed, setFailed] = useState(false);

  const normalizedSrc = typeof src === "string" ? src : "";
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
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
        components={{
          a({ href, children, ...rest }) {
            const parsed = href ? parseHref(href) : undefined;
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
  // File attachment — make it clickable too: opens the raw text/PDF in a new tab.
  const file = part as ContentPart & { type: "file"; name: string; media_type: string; data: string };
  const dataUrl = `data:${file.media_type};base64,${file.data}`;
  // For text files our data field is plain text, not base64. Detect and wrap.
  const href = /^text\/|^application\/json$/.test(file.media_type)
    ? `data:${file.media_type};charset=utf-8,${encodeURIComponent(file.data)}`
    : dataUrl;
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
export const MessageBubble = memo(function MessageBubble({ message, agentConfig, userProfile, showAvatar = true, threadId = null }: Props) {
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
          </div>
        )}
        <div
          className={`rounded-2xl px-4 py-3 text-sm leading-relaxed max-w-full overflow-hidden ${
            isUser ? "glass-bubble-accent text-white rounded-br-sm" : "glass-bubble text-fg rounded-bl-sm"
          }`}
        >
          {typeof parsed === "string" ? (
            isUser ? (
              <p className="whitespace-pre-wrap">{parsed}</p>
            ) : (
              <MarkdownContent text={renderedString ?? parsed} streaming={streaming} onInAppLink={handleInAppLink} />
            )
          ) : (
            <div className="flex flex-col gap-1.5">
              {parsed.map((part, i) => (
                <ContentPartView key={i} part={part} isUser={isUser} onInAppLink={handleInAppLink} />
              ))}
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
        {!isUser && !streaming && "tool_events" in message && Array.isArray(message.tool_events) && message.tool_events.length > 0 && (
          <ToolList events={message.tool_events} />
        )}
        {refs.length > 0 && <RefsFooter refs={refs} />}
      </div>
    </div>
  );
});
