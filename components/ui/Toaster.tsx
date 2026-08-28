"use client";
import { AlertCircle, Bot, ChevronDown, ChevronRight, Copy, ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { dismissToast, type Toast, useToasts } from "@/lib/ui/toasts";
import { useAppContext } from "@/contexts/AppContext";
import { parseHref } from "@/lib/ui/navigate";
import { buildReport } from "@/lib/ui/error-report";

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

// Bottom-right stack, max 4 visible. Older toasts beyond that auto-collapse.
const MAX_VISIBLE = 4;

export function Toaster() {
  const { state } = useAppContext();
  const toasts = useToasts();
  const visible = toasts.slice(-MAX_VISIBLE);
  const chatPlacement = state.activeTab === "chat";

  return (
    <div
      className="fixed z-50 flex flex-col-reverse gap-2 pointer-events-none w-[360px] max-w-[calc(100vw-2rem)]"
      style={{
        right: "max(1rem, calc(env(safe-area-inset-right) + 0.5rem))",
        ...(chatPlacement
          ? { top: "calc(var(--app-safe-top) + 4rem)" }
          : { bottom: "max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))" }),
      }}
      aria-live="polite"
    >
      {visible.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const { dispatch } = useAppContext();
  const [paused, setPaused] = useState(false);
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = useRef<number>(toast.ttl);
  // Lazy useState init runs during the first render only and is invoked by
  // React itself, satisfying react-hooks/purity. We capture mount time as a
  // stable value (effectively a ref) without calling Date.now() inline.
  const [startedAt] = useState<number>(() => Date.now());
  const startedRef = useRef<number>(startedAt);

  // Auto-dismiss with hover-to-pause. Reset timer on hover-out using the
  // remaining duration so a 6s toast that you hovered for 3s still gets ~3s
  // after you leave, not a fresh 6s.
  useEffect(() => {
    if (toast.ttl <= 0) return;
    if (paused) {
      if (timerRef.current) clearTimeout(timerRef.current);
      remainingRef.current -= Date.now() - startedRef.current;
      return;
    }
    startedRef.current = Date.now();
    timerRef.current = setTimeout(() => {
      setExiting(true);
      setTimeout(() => dismissToast(toast.id), 200);
    }, Math.max(remainingRef.current, 0));
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [paused, toast.id, toast.ttl, toast.created_at]);

  // When the store refreshes this toast via dedupe (same id, new
  // created_at), reset the countdown so the fresh ttl gets a fresh
  // window — otherwise the card would still dismiss at the ORIGINAL
  // mount time + ttl even though the underlying error just re-fired.
  useEffect(() => {
    remainingRef.current = toast.ttl;
    startedRef.current = Date.now();
    setExiting(false);
  }, [toast.created_at, toast.ttl]);

  function close() {
    setExiting(true);
    setTimeout(() => dismissToast(toast.id), 200);
  }

  function open() {
    if (toast.href) {
      const parsed = parseHref(toast.href);
      if (parsed.tab) {
        dispatch({ type: "SET_TAB", tab: parsed.tab });
        dispatch({ type: "SET_SELECTION", tab: parsed.tab, itemId: parsed.item ?? null });
      }
      if (parsed.hash && typeof window !== "undefined") {
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${parsed.hash}`);
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      }
    } else if (toast.thread_id && toast.agent_id) {
      // Reply / scheduled-task / bridge-message toasts — land on the exact
      // thread the event happened in, not just the agent's last-active one.
      dispatch({ type: "SELECT_THREAD", threadId: toast.thread_id, agentId: toast.agent_id });
    } else if (toast.agent_id) {
      dispatch({ type: "SET_AGENT", agentId: toast.agent_id });
      dispatch({ type: "SET_TAB", tab: "chat" });
    }
    close();
  }

  const isError = toast.kind === "error";
  // Error toasts with expandable details (stack trace + Copy + Report).
  // Stop propagation on every interactive sub-element so clicks don't
  // trigger the body's open()/navigate behavior.
  const hasReport = isError && (toast.details != null || toast.reportInput != null);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  async function onCopy(e: React.MouseEvent) {
    e.stopPropagation();
    if (!toast.reportInput) return;
    const { body } = await buildReport(toast.reportInput);
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard rejected (no focus, secure context, etc.) — open a window
      // with the text instead so the user can copy manually.
      const win = window.open("", "_blank", "noopener,noreferrer,width=600,height=400");
      if (win) {
        win.document.body.innerText = body;
      }
    }
  }

  async function onReport(e: React.MouseEvent) {
    e.stopPropagation();
    if (!toast.reportInput) return;
    const { url } = await buildReport(toast.reportInput);
    window.open(url, "_blank", "noopener,noreferrer");
  }
  // Avatar — when we have an agent_id use a deterministic gradient. Otherwise
  // fall back to a generic bot icon.
  const avatar = toast.agent_id ? (
    <div className={`w-9 h-9 rounded-lg bg-gradient-to-br ${gradientFor(toast.agent_id)} flex items-center justify-center text-sm font-bold text-white shrink-0`}>
      {toast.title.charAt(0).toUpperCase()}
    </div>
  ) : (
    <div className="w-9 h-9 rounded-lg bg-surface-3 flex items-center justify-center shrink-0">
      {isError ? <AlertCircle size={16} className="text-rose-700 dark:text-rose-400" /> : <Bot size={16} className="text-fg-muted" />}
    </div>
  );

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onClick={open}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") open(); }}
      className={`pointer-events-auto group relative cursor-pointer rounded-xl border bg-surface-2/95 backdrop-blur shadow-2xl transition-all duration-200 ${
        exiting ? "opacity-0 translate-x-2" : "opacity-100 translate-x-0"
      } ${isError ? "border-rose-700/60" : "border-border hover:border-border"}`}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        {avatar}
        <div className="flex-1 min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-fg-faint font-semibold truncate">
            {toast.sourceLabel}
          </p>
          <p className="text-sm font-medium text-fg truncate">{toast.title}</p>
          {toast.preview ? (
            <p className={`text-xs ${isError ? "text-rose-700 dark:text-rose-300/90" : "text-fg-muted"} line-clamp-2 mt-0.5 italic`}>
              “{toast.preview}”
            </p>
          ) : (
            <p className={`text-xs ${isError ? "text-rose-700 dark:text-rose-300/90" : "text-fg-subtle"} line-clamp-2 mt-0.5`}>
              {toast.body}
            </p>
          )}
          {toast.href ? (
            <p className="text-[10px] text-accent/80 mt-1">{toast.hrefLabel ?? "Open →"}</p>
          ) : (toast.agent_id || toast.thread_id) ? (
            <p className="text-[10px] text-accent/80 mt-1">Open chat →</p>
          ) : null}
          {hasReport && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
              className="control-tap mt-1.5 inline-flex items-center gap-1 text-[10px] text-rose-700 dark:text-rose-300/90 hover:text-rose-900 dark:hover:text-rose-200"
              aria-expanded={expanded}
            >
              {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {expanded ? "Hide details" : "Show details"}
            </button>
          )}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); close(); }}
          className="control-tap opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity px-1.5 -mr-1 -mt-0.5 text-fg-faint hover:text-fg"
          aria-label="Dismiss"
        >
          <X size={13} />
        </button>
      </div>
      {hasReport && expanded && (
        <div
          className="border-t border-rose-700/30 bg-rose-50/40 dark:bg-rose-950/20 px-3 py-2 space-y-2"
          onClick={(e) => e.stopPropagation()}
        >
          {toast.details && (
            <pre className="text-[10px] leading-snug text-rose-900 dark:text-rose-200/90 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono bg-surface-3/60 rounded p-2">
              {toast.details}
            </pre>
          )}
          {toast.reportInput && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onCopy}
                className="control-tap inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-surface-3 hover:bg-surface-4 text-fg border border-border"
              >
                <Copy size={11} />
                {copied ? "Copied" : "Copy report"}
              </button>
              <button
                type="button"
                onClick={onReport}
                className="control-tap inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-rose-600 hover:bg-rose-700 text-white"
                title="Opens a pre-filled GitHub issue"
              >
                <ExternalLink size={11} />
                Report this issue
              </button>
            </div>
          )}
        </div>
      )}
      {/* Bottom progress sliver showing time remaining; pauses on hover.
          Keyed by created_at so a dedupe refresh restarts the CSS
          animation from 100% instead of continuing the stale run. */}
      {toast.ttl > 0 && !exiting && (
        <div
          key={toast.created_at}
          className="absolute bottom-0 left-0 right-0 h-[2px] origin-left rounded-bl-xl"
          style={{
            backgroundColor: isError ? "#fb7185" : "#3b82f6",
            animation: paused ? "none" : `jarela-toast-shrink ${toast.ttl}ms linear forwards`,
          }}
        />
      )}
    </div>
  );
}
