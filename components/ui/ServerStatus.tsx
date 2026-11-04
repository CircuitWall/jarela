"use client";

// Keep liveness independent from SQLite and agent-config reads. Only a
// confirmed outage is surfaced here; routine runtime details stay out of
// the app's primary navigation area.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CloudOff } from "lucide-react";
import { runtimeConfig } from "@/api/runtime-config";
import { SERVER_ACTIVITY_EVENT, SERVER_ACTIVITY_UPDATE_EVENT } from "@/api/health";

const HEALTHY_INTERVAL_MS = 20_000;
const DOWN_INTERVAL_MS = 5_000;
const RETRY_INTERVAL_MS = 3_000;
const FAILURE_THRESHOLD = 3;
const DOWN_CONFIRMATION_MS = 30_000;

function activeRunCount(body: unknown): number | null {
  if (!body || typeof body !== "object" || !("activity" in body)
    || !body.activity || typeof body.activity !== "object"
    || !("active_runs" in body.activity)
    || typeof body.activity.active_runs !== "number"
    || !Number.isSafeInteger(body.activity.active_runs)
    || body.activity.active_runs < 0) return null;
  return body.activity.active_runs;
}

async function ping(): Promise<{ ok: boolean; activeRuns: number | null }> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), runtimeConfig().healthCheckTimeoutMs);
  try {
    const res = await fetch("/api/v1/health/liveness", { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) return { ok: false, activeRuns: null };
    try {
      return { ok: true, activeRuns: activeRunCount(await res.json()) };
    } catch {
      // Older servers can still prove liveness with an empty success response.
      return { ok: true, activeRuns: null };
    }
  } catch {
    return { ok: false, activeRuns: null };
  } finally {
    clearTimeout(timeout);
  }
}

function ServerUnavailable({ activeRuns }: { activeRuns: number | null }) {
  const hasActiveRuns = (activeRuns ?? 0) > 0;
  return (
    <div role="status" aria-live="polite" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="mx-4 max-w-sm w-full flex flex-col items-center gap-3 rounded-xl border border-border bg-surface text-fg px-6 py-5 text-center shadow-lg">
        <CloudOff size={28} className="text-amber-500" />
        <div className="text-sm font-medium">Server unavailable</div>
        <div className="text-xs text-fg-muted">
          {hasActiveRuns
            ? `Connection lost; the last response reported ${activeRuns} active agent ${activeRuns === 1 ? "run" : "runs"}. Retrying...`
            : "Cannot connect to Jarela. Retrying..."}
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

export function ServerStatus() {
  const [down, setDown] = useState(false);
  const [activeRuns, setActiveRuns] = useState<number | null>(null);
  const wasDownRef = useRef(false);
  const failureCountRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let probeInFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let outageStartedAt: number | null = null;

    const recoverFromActivity = () => {
      if (failureCountRef.current === 0 && !wasDownRef.current) return;
      failureCountRef.current = 0;
      outageStartedAt = null;
      wasDownRef.current = false;
      setDown(false);
    };

    const onServerActivity = () => recoverFromActivity();

    const onActivityUpdate = (event: Event) => {
      const count = activeRunCount({ activity: (event as CustomEvent).detail });
      if (count === null) return;
      setActiveRuns(count);
      recoverFromActivity();
    };

    const tick = async () => {
      if (probeInFlight) return;
      probeInFlight = true;
      try {
        const result = await ping();
        if (cancelled) return;
        if (!result.ok) {
          failureCountRef.current += 1;
          const failedAt = Date.now();
          outageStartedAt ??= failedAt;
          const outageConfirmed =
            failureCountRef.current >= FAILURE_THRESHOLD &&
            failedAt - outageStartedAt >= DOWN_CONFIRMATION_MS;
          if (outageConfirmed) {
            wasDownRef.current = true;
            setDown(true);
            timer = setTimeout(tick, DOWN_INTERVAL_MS);
          } else {
            timer = setTimeout(
              tick,
              failureCountRef.current >= FAILURE_THRESHOLD ? DOWN_INTERVAL_MS : RETRY_INTERVAL_MS,
            );
          }
          return;
        }
        failureCountRef.current = 0;
        outageStartedAt = null;
        setActiveRuns(result.activeRuns);
        if (wasDownRef.current) {
          window.location.reload();
          return;
        }
        setDown(false);
        timer = setTimeout(tick, HEALTHY_INTERVAL_MS);
      } finally {
        probeInFlight = false;
      }
    };

    window.addEventListener(SERVER_ACTIVITY_EVENT, onServerActivity);
    window.addEventListener(SERVER_ACTIVITY_UPDATE_EVENT, onActivityUpdate);
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
      window.removeEventListener(SERVER_ACTIVITY_EVENT, onServerActivity);
      window.removeEventListener(SERVER_ACTIVITY_UPDATE_EVENT, onActivityUpdate);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (down) {
    return typeof document === "undefined"
      ? null
      : createPortal(<ServerUnavailable activeRuns={activeRuns} />, document.body);
  }
  return null;
}
