"use client";

// Health-check overlay. Polls /api/v1/health on a slow cadence while the
// server is reachable; after a sustained outage, shows a blocking banner
// while retrying. When the server comes back, reloads the page so
// any in-flight UI state (caches, EventSource subscriptions, agent list)
// gets a clean restart instead of trying to splice partial state back
// together.
//
// Brief health-check failures can happen during long agent turns or transient
// network hiccups. Require consecutive failures over a minimum outage duration
// before surfacing "Server unavailable", avoiding unnecessary interruptions.

import { useEffect, useRef, useState } from "react";
import { CloudOff } from "lucide-react";
import { runtimeConfig } from "@/api/runtime-config";

const HEALTHY_INTERVAL_MS = 20_000;
const DOWN_INTERVAL_MS = 5_000;
const RETRY_INTERVAL_MS = 3_000;
const FAILURE_THRESHOLD = 3;
const DOWN_CONFIRMATION_MS = 30_000;

async function ping(): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), runtimeConfig().healthCheckTimeoutMs);
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
  const failureCountRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let probeInFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let outageStartedAt: number | null = null;

    const tick = async () => {
      if (probeInFlight) return;
      probeInFlight = true;
      try {
        const ok = await ping();
        if (cancelled) return;
        if (!ok) {
          failureCountRef.current += 1;
          outageStartedAt ??= Date.now();
          const outageConfirmed =
            failureCountRef.current >= FAILURE_THRESHOLD &&
            Date.now() - outageStartedAt >= DOWN_CONFIRMATION_MS;
          if (outageConfirmed) {
            wasDownRef.current = true;
            setDown(true);
            timer = setTimeout(tick, DOWN_INTERVAL_MS);
          } else {
            // Keep checking, but do not interrupt the user for a brief outage.
            timer = setTimeout(
              tick,
              failureCountRef.current >= FAILURE_THRESHOLD ? DOWN_INTERVAL_MS : RETRY_INTERVAL_MS,
            );
          }
          return;
        }
        failureCountRef.current = 0;
        outageStartedAt = null;
        if (wasDownRef.current) {
          // Server recovered after the overlay actually showed — full reload
          // to drop any stale in-memory state (EventSource queues, agent
          // cache, MCP clients) and re-bootstrap.
          window.location.reload();
          return;
        }
        setDown(false);
        timer = setTimeout(tick, HEALTHY_INTERVAL_MS);
      } finally {
        probeInFlight = false;
      }
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
    <div role="status" aria-live="polite" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="mx-4 max-w-sm w-full flex flex-col items-center gap-3 rounded-xl border border-border bg-surface text-fg px-6 py-5 text-center shadow-lg">
        <CloudOff size={28} className="text-amber-500" />
        <div className="text-sm font-medium">Server unavailable</div>
        <div className="text-xs text-fg-muted">Cannot connect to Jarela. Retrying...</div>
        {down && <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-1 text-xs underline text-fg-subtle hover:text-fg"
        >
          Reload now
        </button>}
      </div>
    </div>
  );
}
