"use client";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Bot, ChevronRight, Link as LinkIcon, Paperclip, User, X } from "lucide-react";
import type { AgentConfig, Message, UserProfile } from "@/api/types";
import type { ContentPart } from "@/api/types";

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
      <Bot size={13} className="text-zinc-500" />
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
      <User size={13} className="text-zinc-500" />
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

function MarkdownContent({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none langgui-rich">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
        components={{
          a({ href, children, ...rest }) {
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
              <code className="bg-surface-2 px-1 rounded text-zinc-300 break-all">{code}</code>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
      {streaming && <span className="inline-block w-2 h-4 bg-zinc-400 animate-pulse ml-0.5 align-middle" />}
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
        className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
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
                className="text-sky-400 hover:text-sky-300 hover:underline truncate inline-block max-w-full align-middle"
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

function ContentPartView({ part, isUser }: { part: ContentPart; isUser: boolean }) {
  if (part.type === "text") {
    return isUser
      ? <p className="whitespace-pre-wrap">{part.text}</p>
      : <MarkdownContent text={part.text} />;
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
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 mt-1 rounded-lg border border-border/60 bg-surface-3/60 hover:bg-surface-3 hover:border-zinc-600 text-[11px] text-zinc-300 transition-colors"
      title="Open in new tab"
    >
      <Paperclip size={11} className="text-zinc-500 shrink-0" />
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
        className="max-w-full rounded-xl mt-1 border border-border/40 cursor-zoom-in hover:border-zinc-500 transition-colors"
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

export function MessageBubble({ message, agentConfig, userProfile, showAvatar = true }: Props) {
  const isUser = message.role === "user";
  const streaming = "streaming" in message && message.streaming;
  const parsed = parseContent(message.content);

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

  return (
    <div className={`flex ${isUser ? "flex-row-reverse" : "flex-row"} gap-2 mb-1.5 items-end`}>
      {/* Avatar — spacer when not shown to maintain alignment */}
      <div className="shrink-0 w-7">
        {showAvatar && (isUser
          ? <UserAvatar profile={userProfile} />
          : <AgentAvatar config={agentConfig} />
        )}
      </div>

      <div className={`flex flex-col max-w-[75%] min-w-0 ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`rounded-2xl px-4 py-3 text-sm leading-relaxed max-w-full overflow-hidden ${
            isUser ? "bg-accent text-white rounded-br-sm" : "bg-surface-3 text-zinc-100 rounded-bl-sm"
          }`}
        >
          {typeof parsed === "string" ? (
            isUser ? (
              <p className="whitespace-pre-wrap">{parsed}</p>
            ) : (
              <MarkdownContent text={renderedString ?? parsed} streaming={streaming} />
            )
          ) : (
            <div className="flex flex-col gap-1.5">
              {parsed.map((part, i) => (
                <ContentPartView key={i} part={part} isUser={isUser} />
              ))}
              {streaming && <span className="inline-block w-2 h-4 bg-zinc-400 animate-pulse ml-0.5 align-middle" />}
            </div>
          )}
        </div>
        {refs.length > 0 && <RefsFooter refs={refs} />}
      </div>
    </div>
  );
}
