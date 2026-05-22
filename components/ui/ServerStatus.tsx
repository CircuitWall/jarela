"use client";

// Health-check overlay. Polls /api/v1/health on a slow cadence while the
// server is reachable; on the first failure, flips into a fast retry loop
// behind a blocking banner. When the server comes back, reloads the page so
// any in-flight UI state (caches, EventSource subscriptions, agent list)
// gets a clean restart instead of trying to splice partial state back
// together.

import { useEffect, useRef, useState } from "react";
import { CloudOff, Loader2 } from "lucide-react";

const HEALTHY_INTERVAL_MS = 20_000;
const DOWN_INTERVAL_MS = 2_000;
const FETCH_TIMEOUT_MS = 4_000;

async function ping(): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("/api/v1/health", { cache: "no-store", signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export function ServerStatus() {
  const [down, setDown] = useState(false);
  const wasDownRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const ok = await ping();
      if (cancelled) return;
      if (!ok) {
        wasDownRef.current = true;
        setDown(true);
        timer = setTimeout(tick, DOWN_INTERVAL_MS);
        return;
      }
      if (wasDownRef.current) {
        // Server recovered — full reload to drop any stale in-memory state
        // (EventSource queues, agent cache, MCP clients) and re-bootstrap.
        window.location.reload();
        return;
      }
      setDown(false);
      timer = setTimeout(tick, HEALTHY_INTERVAL_MS);
    };

    tick();

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        if (timer) clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!down) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="mx-4 max-w-sm w-full flex flex-col items-center gap-3 rounded-xl border border-border bg-surface text-fg px-6 py-5 text-center shadow-lg">
        <CloudOff size={28} className="text-amber-500" />
        <div className="text-sm font-medium">Server unavailable</div>
        <div className="text-xs text-fg-muted">
          Lost connection to Jarela. Retrying…
        </div>
        <div className="flex items-center gap-2 text-xs text-fg-subtle">
          <Loader2 size={14} className="animate-spin" />
          <span>Reconnecting</span>
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-1 text-xs underline text-fg-subtle hover:text-fg"
        >
          Reload now
        </button>
      </div>
    </div>
  );
}
