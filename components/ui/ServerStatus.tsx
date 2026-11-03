"use client";

// Keep liveness independent from SQLite and agent-config reads. Deeper
// diagnostics run only after the fast check succeeds and never drive the
// blocking outage overlay.

import { useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, CloudOff, LoaderCircle } from "lucide-react";
import { runtimeConfig } from "@/api/runtime-config";
import { fetchHealthDetails, SERVER_ACTIVITY_EVENT } from "@/api/health";

const HEALTHY_INTERVAL_MS = 20_000;
const DOWN_INTERVAL_MS = 5_000;
const RETRY_INTERVAL_MS = 3_000;
const FAILURE_THRESHOLD = 3;
const DOWN_CONFIRMATION_MS = 30_000;
const DETAILS_NOTICE_MS = 5_000;

type Diagnostics =
  | { status: "checking" }
  | { status: "ready"; agentCount: number; cryptoSource: string }
  | { status: "unavailable" };

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

function RuntimeStatusNotice({ activeRuns, diagnostics, streamResponsive }: {
  activeRuns: number | null;
  diagnostics: Diagnostics | null;
  streamResponsive: boolean;
}) {
  const hasActiveRuns = (activeRuns ?? 0) > 0;
  const detailsChecking = diagnostics?.status === "checking";
  const detailsUnavailable = diagnostics?.status === "unavailable";
  const detailsReady = diagnostics?.status === "ready" ? diagnostics : null;
  const detailsSummary = detailsReady
    ? `database responded; found ${detailsReady.agentCount} agent ${detailsReady.agentCount === 1 ? "configuration" : "configurations"}; encryption uses ${detailsReady.cryptoSource}`
    : null;
  const message = streamResponsive
    ? `Jarela is responding to the active workflow${hasActiveRuns ? `; ${activeRuns} agent ${activeRuns === 1 ? "run is" : "runs are"} active` : ""}.`
    : hasActiveRuns
    ? `Jarela is responding; ${activeRuns} agent ${activeRuns === 1 ? "run is" : "runs are"} active${detailsChecking ? " · checking runtime details" : detailsSummary ? ` · ${detailsSummary}` : ""}.`
    : detailsChecking
      ? "Jarela is responding; checking runtime details..."
      : detailsReady
        ? `Runtime checks finished: ${detailsSummary}.`
        : "Jarela is responding; runtime details could not be checked.";

  return (
    <div className="fixed bottom-3 right-3 z-[90] pointer-events-none">
      <div role="status" aria-live="polite" className="pointer-events-auto flex max-w-sm items-center gap-2 rounded-lg border border-border bg-surface/95 px-3 py-2 text-xs text-fg shadow-lg backdrop-blur">
        {hasActiveRuns
          ? <Activity size={14} className="shrink-0 text-accent" />
          : detailsChecking
            ? <LoaderCircle size={14} className="shrink-0 animate-spin text-accent" />
            : detailsUnavailable
              ? <AlertTriangle size={14} className="shrink-0 text-amber-500" />
              : <CheckCircle2 size={14} className="shrink-0 text-emerald-500" />}
        <span>{message}</span>
      </div>
    </div>
  );
}

export function ServerStatus() {
  const [down, setDown] = useState(false);
  const [activeRuns, setActiveRuns] = useState<number | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [streamResponsive, setStreamResponsive] = useState(false);
  const wasDownRef = useRef(false);
  const failureCountRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let probeInFlight = false;
    let detailsStarted = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let noticeTimer: ReturnType<typeof setTimeout> | null = null;
    let streamNoticeTimer: ReturnType<typeof setTimeout> | null = null;
    let outageStartedAt: number | null = null;

    const onServerActivity = () => {
      if (failureCountRef.current === 0 && !wasDownRef.current) return;
      failureCountRef.current = 0;
      outageStartedAt = null;
      wasDownRef.current = false;
      setDown(false);
      setStreamResponsive(true);
      if (streamNoticeTimer) clearTimeout(streamNoticeTimer);
      streamNoticeTimer = setTimeout(() => {
        if (!cancelled) setStreamResponsive(false);
      }, DETAILS_NOTICE_MS);
    };

    const loadDetails = () => {
      if (detailsStarted) return;
      detailsStarted = true;
      setDiagnostics({ status: "checking" });
      setShowDiagnostics(true);
      void fetchHealthDetails()
        .then((result) => {
          if (cancelled) return;
          setDiagnostics({
            status: "ready",
            agentCount: result.agents.length,
            cryptoSource: result.crypto.source,
          });
          noticeTimer = setTimeout(() => {
            if (!cancelled) setShowDiagnostics(false);
          }, DETAILS_NOTICE_MS);
        })
        .catch(() => {
          if (cancelled) return;
          setDiagnostics({ status: "unavailable" });
          noticeTimer = setTimeout(() => {
            if (!cancelled) setShowDiagnostics(false);
          }, DETAILS_NOTICE_MS);
        });
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
        setStreamResponsive(false);
        if (streamNoticeTimer) clearTimeout(streamNoticeTimer);
        setActiveRuns(result.activeRuns);
        loadDetails();
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
      if (noticeTimer) clearTimeout(noticeTimer);
      if (streamNoticeTimer) clearTimeout(streamNoticeTimer);
      window.removeEventListener(SERVER_ACTIVITY_EVENT, onServerActivity);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const hasActiveRuns = (activeRuns ?? 0) > 0;
  if (down && !streamResponsive) return <ServerUnavailable activeRuns={activeRuns} />;
  if (!hasActiveRuns && !showDiagnostics && !streamResponsive) return null;
  return <RuntimeStatusNotice activeRuns={activeRuns} diagnostics={diagnostics} streamResponsive={streamResponsive} />;
}
