"use client";
import { AlertCircle, Bot, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { dismissToast, type Toast, useToasts } from "@/lib/ui/toasts";
import { useAppContext } from "@/contexts/AppContext";

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
  const toasts = useToasts();
  const visible = toasts.slice(-MAX_VISIBLE);

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col-reverse gap-2 pointer-events-none w-[360px] max-w-[calc(100vw-2rem)]"
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
  }, [paused, toast.id, toast.ttl]);

  function close() {
    setExiting(true);
    setTimeout(() => dismissToast(toast.id), 200);
  }

  function open() {
    if (toast.agent_id) {
      dispatch({ type: "SET_AGENT", agentId: toast.agent_id });
      dispatch({ type: "SET_TAB", tab: "chat" });
    }
    close();
  }

  const isError = toast.kind === "error";
  // Avatar — when we have an agent_id use a deterministic gradient. Otherwise
  // fall back to a generic bot icon.
  const avatar = toast.agent_id ? (
    <div className={`w-9 h-9 rounded-lg bg-gradient-to-br ${gradientFor(toast.agent_id)} flex items-center justify-center text-sm font-bold text-white shrink-0`}>
      {toast.title.charAt(0).toUpperCase()}
    </div>
  ) : (
    <div className="w-9 h-9 rounded-lg bg-surface-3 flex items-center justify-center shrink-0">
      {isError ? <AlertCircle size={16} className="text-rose-400" /> : <Bot size={16} className="text-fg-muted" />}
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
            <p className={`text-xs ${isError ? "text-rose-300/90" : "text-fg-muted"} line-clamp-2 mt-0.5 italic`}>
              “{toast.preview}”
            </p>
          ) : (
            <p className={`text-xs ${isError ? "text-rose-300/90" : "text-fg-subtle"} line-clamp-2 mt-0.5`}>
              {toast.body}
            </p>
          )}
          {(toast.agent_id || toast.thread_id) && (
            <p className="text-[10px] text-accent/80 mt-1">Open chat →</p>
          )}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); close(); }}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 -mr-1 -mt-0.5 text-fg-faint hover:text-fg"
          aria-label="Dismiss"
        >
          <X size={13} />
        </button>
      </div>
      {/* Bottom progress sliver showing time remaining; pauses on hover. */}
      {toast.ttl > 0 && !exiting && (
        <div
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
