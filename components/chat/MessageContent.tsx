"use client";
import { memo, useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { Check, Copy, Download, ExternalLink, FileText, Loader2, Paperclip } from "lucide-react";
import type { ContentPart } from "@/api/types";
import { Dialog } from "@/components/ui/Dialog";
import { parseHref } from "@/lib/ui/navigate";
import { pushToast } from "@/lib/ui/toasts";
import { errorMessage } from "@/lib/utils/error";
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


function isLikelyLocalFileHref(href: string): boolean {
  if (!href || href.startsWith("#")) return false;
  if (/^(mailto|tel|javascript|data|blob):/i.test(href)) return false;
  if (/^file:\/\//i.test(href)) return true;
  if (/^[A-Za-z]:[\\/]/.test(href) || href.startsWith("~/") || href.startsWith("~\\")) return true;
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)) return false;
      return !/^\/(api|_next)(\/|$)/.test(url.pathname);
    } catch {
      return false;
    }
  }
  if (href.startsWith("/")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
  return /(^\.\.?[\\/]|[\\/]|\.[A-Za-z0-9]{1,12}(?:[?#]|$))/.test(href);
}


interface LocalFilePreview {
  path: string;
  name: string;
  size: number;
  renderable: boolean;
  snippet?: string;
  truncated?: boolean;
  error?: string;
}


function LocalFileLink({ href, threadId, children, className, title }: { href: string; threadId?: string | null; children: ReactNode; className?: string; title?: string }) {
  const [preview, setPreview] = useState<LocalFilePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const openDefault = useCallback(async () => {
    setOpenError(null);
    const res = await fetch("/api/v1/local-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ href, thread_id: threadId ?? undefined }),
    });
    const body = await res.json().catch(() => ({} as { error?: string }));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    pushToast({
      kind: "success",
      source: "system",
      sourceLabel: "Chat",
      title: "Opening file",
      body: "Sent the file to the operating system default app.",
      agent_id: null,
      thread_id: threadId ?? null,
      ttl: 1800,
    });
  }, [href, threadId]);

  const activate = useCallback(async () => {
    setLoading(true);
    setOpenError(null);
    try {
      const params = new URLSearchParams({ href });
      if (threadId) params.set("thread_id", threadId);
      const res = await fetch(`/api/v1/local-file?${params.toString()}`);
      const body = await res.json().catch(() => ({} as LocalFilePreview));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const info = body as LocalFilePreview;
      setPreview(info);
      if (!info.renderable) await openDefault();
    } catch (err) {
      const msg = errorMessage(err);
      setOpenError(msg);
      pushToast({
        kind: "error",
        source: "system",
        sourceLabel: "Chat",
        title: "Could not open file",
        body: msg,
        agent_id: null,
        thread_id: threadId ?? null,
        ttl: 5000,
      });
    } finally {
      setLoading(false);
    }
  }, [href, openDefault, threadId]);

  return (
    <span className="inline-flex flex-col max-w-full align-baseline">
      <button
        type="button"
        className={`${className ?? ""} inline-flex items-baseline gap-1 text-left underline decoration-dotted hover:decoration-solid break-all`.trim()}
        title={title ?? href}
        onClick={activate}
        disabled={loading}
      >
        <FileText size={12} className="relative top-0.5 shrink-0" />
        <span>{children}</span>
        {loading && <Loader2 size={11} className="relative top-0.5 shrink-0 animate-spin" />}
      </button>
      {preview?.renderable && typeof preview.snippet === "string" && (
        <span className="not-prose my-2 block rounded-md border border-border/60 bg-surface-2 overflow-hidden">
          <span className="flex items-center justify-between gap-2 px-2 py-1 text-[10px] text-fg-faint bg-surface-3">
            <span className="truncate" title={preview.path}>{preview.path}</span>
            <button
              type="button"
              onClick={openDefault}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border/60 bg-surface-2 text-fg-muted hover:text-fg shrink-0"
            >
              <ExternalLink size={10} />
              Open
            </button>
          </span>
          <code className="block max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-xs leading-relaxed text-fg-muted bg-[#0d1117]">
            {preview.snippet}{preview.truncated ? "\n..." : ""}
          </code>
        </span>
      )}
      {openError && <span className="text-[11px] text-rose-400 mt-1">{openError}</span>}
    </span>
  );
}


function reactChildrenToText(children: ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(reactChildrenToText).join("");
  if (typeof children === "object" && "props" in (children as object)) {
    return reactChildrenToText((children as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}


// Markdown image renderer with a one-time automatic retry. If both attempts
// fail (common on transient local-network/SW races), show a compact fallback
// with explicit actions instead of a broken image icon.
function ResilientMarkdownImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const [retryNonce, setRetryNonce] = useState(0);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const objectUrl = useMemo(() => (src instanceof Blob ? URL.createObjectURL(src) : null), [src]);

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  const normalizedSrc = typeof src === "string" ? src : objectUrl ?? "";
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
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={effectiveSrc}
        alt={alt ?? "image"}
        loading="lazy"
        className="rounded-lg border border-border/50 cursor-zoom-in hover:border-fg-faint transition-colors"
        onClick={() => setOpen(true)}
        onError={() => {
          if (retryNonce === 0) {
            setRetryNonce(1);
            return;
          }
          setFailed(true);
        }}
      />
      <ImagePreviewDialog src={normalizedSrc} alt={alt ?? "image"} open={open} onClose={() => setOpen(false)} />
    </>
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
export const MarkdownContent = memo(function MarkdownContent({ text, streaming, onInAppLink, unverifiedLinks, sourceManifest, threadId }: { text: string; streaming?: boolean; onInAppLink?: (href: string) => void; unverifiedLinks?: ReadonlySet<string>; sourceManifest?: ReadonlyMap<number, { href: string; label: string }>; threadId?: string | null }) {
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
            const unverifiedCls = isUnverified ? "decoration-warn decoration-wavy underline-offset-2" : "";
            const unverifiedTitle = isUnverified ? "Agent did not visit this source in this conversation — the citation may be invented." : undefined;
            if (href && isLikelyLocalFileHref(href)) {
              return (
                <LocalFileLink href={href} threadId={threadId} title={unverifiedTitle ?? rest.title} className={`${rest.className ?? ""} ${unverifiedCls}`.trim()}>
                  {children}
                  {isUnverified && <sup className="text-warn ml-0.5" aria-label="unverified citation">⚠</sup>}
                </LocalFileLink>
              );
            }
            const inApp = !!parsed && !parsed.external && (!!parsed.tab || !!parsed.hash || (!!parsed.thread && !!parsed.agent));
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
            if (match?.[1] === "mermaid") {
              return <MermaidFence source={reactChildrenToText(children).replace(/\n$/, "")} />;
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
      {streaming && <span className="jarela-stream-caret" aria-hidden="true" />}
    </div>
  );
});


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


function MermaidFence({ source }: { source: string }) {
  const renderId = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    void (async () => {
      try {
        const [{ default: mermaid }, { default: DOMPurify }] = await Promise.all([
          import("mermaid"),
          import("dompurify"),
        ]);
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base" });
        const result = await mermaid.render(renderId, source);
        if (cancelled) return;
        setSvg(DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true } }));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [renderId, source]);

  if (error) {
    return (
      <div className="my-2 rounded-md border border-warn/40 bg-warn/5 p-2">
        <p className="mb-1 text-[10px] uppercase tracking-wide text-warn">Mermaid preview unavailable</p>
        <CodeFence language="mermaid" className="language-mermaid"><>{source}</></CodeFence>
      </div>
    );
  }
  if (!svg) {
    return <div className="my-2 rounded-md border border-border/60 bg-surface-3/40 p-3 text-xs text-fg-faint">Rendering diagram...</div>;
  }
  return (
    <div className="my-2 max-w-full rounded-md border border-border/60 bg-surface-2">
      <div className="flex items-center justify-between rounded-t-md bg-surface-3 px-2 py-1 text-[10px] text-fg-faint">
        <span>Mermaid</span>
        <a
          href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
          download="diagram.svg"
          className="inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-fg-muted hover:text-fg transition-colors"
          aria-label="Download diagram as SVG"
        >
          <Download size={10} />
          Download SVG
        </a>
      </div>
      <div
        className="max-w-full overflow-x-auto p-3"
        dangerouslySetInnerHTML={{ __html: svg }}
        role="img"
        aria-label="Mermaid diagram"
      />
      <details className="border-t border-border/60 px-2 py-1 text-xs text-fg-muted">
        <summary className="cursor-pointer">Diagram source</summary>
        <CodeFence language="mermaid" className="language-mermaid"><>{source}</></CodeFence>
      </details>
    </div>
  );
}


export function ContentPartView({ part, isUser, onInAppLink, unverifiedLinks, sourceManifest, threadId }: { part: ContentPart; isUser: boolean; onInAppLink?: (href: string) => void; unverifiedLinks?: ReadonlySet<string>; sourceManifest?: ReadonlyMap<number, { href: string; label: string }>; threadId?: string | null }) {
  if (part.type === "text") {
    return <MarkdownContent text={part.text} onInAppLink={onInAppLink} unverifiedLinks={unverifiedLinks} sourceManifest={sourceManifest} threadId={threadId} />;
  }
  if (part.type === "image") {
    return <ClickableImage src={`data:${part.media_type};base64,${part.data}`} />;
  }
  if (part.type === "image_ref") {
    // Ref-based image — server-hosted at /api/v1/files/[name]. See ADR-0065.
    return <ClickableImage src={`/api/v1/files/${encodeURIComponent(part.name)}`} />;
  }
  if (part.type === "file_ref") {
    return <AttachmentLink href={`/api/v1/files/${encodeURIComponent(part.name)}`} filename={part.filename} />;
  }
  // File attachment — render an inline player for audio/video so voice
  // notes and short clips from the WhatsApp bridge are usable in-bubble.
  // Other file types still fall through to a download/open-in-new-tab link.
  const file = part;
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
  return <AttachmentLink href={href} filename={file.name} />;
}

function AttachmentLink({ href, filename }: { href: string; filename: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 mt-1 rounded-lg border border-border/60 bg-surface-3/60 hover:bg-surface-3 hover:border-border text-[11px] text-fg-muted transition-colors"
      title="Open in new tab"
    >
      <Paperclip size={11} className="text-fg-faint shrink-0" />
      <span className="truncate max-w-[200px]">{filename}</span>
    </a>
  );
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
      <ImagePreviewDialog src={src} alt="attached image" open={open} onClose={() => setOpen(false)} />
    </>
  );
}


function ImagePreviewDialog({ src, alt, open, onClose }: { src: string; alt: string; open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Image preview"
      size="full"
      align="center"
      level="elevated"
      padded={false}
      fitViewport
      footer={(
        <div className="flex items-center justify-end gap-2 px-4 pb-3">
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2.5 py-1.5 rounded-md border border-border/70 bg-surface-3 text-xs text-fg-muted hover:text-fg hover:border-border"
          >
            Open in new tab
          </a>
          <button
            type="button"
            onClick={onClose}
            className="px-2.5 py-1.5 rounded-md border border-border/70 bg-surface-3 text-xs text-fg-muted hover:text-fg hover:border-border"
          >
            Close
          </button>
        </div>
      )}
    >
      <div className="h-full w-full min-w-0 bg-black/95 flex items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          className="block max-h-full max-w-full h-auto w-auto object-contain"
        />
      </div>
    </Dialog>
  );
}
