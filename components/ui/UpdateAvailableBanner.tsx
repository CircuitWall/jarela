"use client";

// Surfaces a dismissible banner when the running version is behind the latest
// published to npm. Backed by /api/v1/update.
//
// Adds a one-click "Update now" affordance that POSTs to
// /api/v1/update/apply, polls the in-memory job state, then once the
// server exits and is back up clears the SW + Cache Storage so the new
// HTML/JS/CSS isn't served from the precache.

import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";

type UpdateInfo = {
  channel?: "stable" | "main";
  current: string;
  latest: string | null;
  behind: boolean;
  latestCommit?: { sha: string; date: string | null };
  currentCommit?: string;
};

type ApplyState =
  | { state: "idle" }
  | { state: "running"; startedAt: number; lines: string[] }
  | {
      state: "completed";
      startedAt: number;
      finishedAt: number;
      lines: string[];
      willExitAt: number;
    }
  | {
      state: "failed";
      startedAt: number;
      finishedAt: number;
      lines: string[];
      exitCode: number;
    };

type Phase =
  | "preview"
  | "installing"
  | "restarting"
  | "waiting-for-server"
  | "failed";

const DISMISS_KEY = "jarela:update-banner-dismissed-for";
const POLL_INTERVAL_MS = 1000;
const HEALTH_POLL_INTERVAL_MS = 1500;
const HEALTH_POLL_TIMEOUT_MS = 120_000;

async function clearCachesAndReload() {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch {
    /* best-effort */
  }
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* best-effort */
  }
  // Force a hard navigation that bypasses both the precache and HTTP cache.
  const sep = window.location.search ? "&" : "?";
  window.location.href = `${window.location.pathname}${window.location.search}${sep}_=${Date.now()}${window.location.hash}`;
}

export function UpdateAvailableBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [phase, setPhase] = useState<Phase>("preview");
  const [lines, setLines] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/update")
      .then((r) => r.json())
      .then((j: UpdateInfo) => {
        if (cancelled) return;
        if (!j?.behind || !j.latest) return;
        const dismissKey =
          j.channel === "main" && j.latestCommit?.sha
            ? `${j.latest}@${j.latestCommit.sha}`
            : j.latest;
        const dismissedFor =
          typeof localStorage !== "undefined"
            ? localStorage.getItem(DISMISS_KEY)
            : null;
        if (dismissedFor === dismissKey) {
          setDismissed(true);
        }
        setInfo(j);
      })
      .catch(() => {
        /* update check is best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  if (!info || !info.behind || !info.latest || dismissed) return null;

  const isMain = info.channel === "main";
  const shortRemote = info.latestCommit?.sha?.slice(0, 7);
  const shortLocal = info.currentCommit?.slice(0, 7);

  async function pollApplyStatus() {
    try {
      const r = await fetch("/api/v1/update/apply", { cache: "no-store" });
      if (!r.ok) throw new Error(`status ${r.status}`);
      const s = (await r.json()) as ApplyState;
      if (s.state === "running") {
        setLines(s.lines.slice(-8));
        pollTimerRef.current = setTimeout(pollApplyStatus, POLL_INTERVAL_MS);
        return;
      }
      if (s.state === "completed") {
        setLines(s.lines.slice(-8));
        setPhase("restarting");
        const waitFor = Math.max(0, s.willExitAt + 500 - Date.now());
        pollTimerRef.current = setTimeout(() => {
          setPhase("waiting-for-server");
          waitForServerThenReload();
        }, waitFor);
        return;
      }
      if (s.state === "failed") {
        setLines(s.lines.slice(-12));
        setPhase("failed");
        setErrorMsg(`Update exited ${s.exitCode}. See log below.`);
        return;
      }
      setPhase("waiting-for-server");
      waitForServerThenReload();
    } catch {
      setPhase("waiting-for-server");
      waitForServerThenReload();
    }
  }

  async function waitForServerThenReload() {
    const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const r = await fetch("/api/v1/health", { cache: "no-store" });
        if (r.ok) {
          await clearCachesAndReload();
          return;
        }
      } catch {
        /* server still down */
      }
      await new Promise((res) => setTimeout(res, HEALTH_POLL_INTERVAL_MS));
    }
    setPhase("failed");
    setErrorMsg(
      "Server didn't come back within 2 minutes. Restart it manually then refresh the page.",
    );
  }

  async function applyUpdate() {
    setPhase("installing");
    setErrorMsg(null);
    setLines([]);
    try {
      const r = await fetch("/api/v1/update/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      if (r.status === 409) {
        pollApplyStatus();
        return;
      }
      if (!r.ok) {
        const detail = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `apply failed (${r.status})`);
      }
      pollApplyStatus();
    } catch (e) {
      setPhase("failed");
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }

  const headline =
    phase === "preview"
      ? isMain
        ? "Experimental update available"
        : "Update available"
      : phase === "installing"
        ? "Installing update…"
        : phase === "restarting"
          ? "Update installed — restarting server…"
          : phase === "waiting-for-server"
            ? "Waiting for server to come back…"
            : "Update failed";

  return (
    <div
      className="fixed left-0 right-0 z-30 px-3 pt-2 pointer-events-none"
      style={{ top: "calc(3rem + var(--app-safe-top))" }}
    >
      <div className="mx-auto max-w-4xl pointer-events-auto flex flex-col gap-1 border border-emerald-900/40 rounded-lg bg-emerald-950/60 backdrop-blur px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">
        <div className="flex items-start gap-2">
          <Download size={14} className="mt-0.5 shrink-0" />
          <div className="flex-1">
            <span className="font-medium">{headline}:</span>{" "}
            {isMain && shortRemote
              ? <>{shortLocal ?? info.current} → {shortRemote} ({info.latest}).</>
              : <>{info.current} → {info.latest}.</>}
            {phase === "preview" && (
              <>
                {" "}
                Click <span className="font-medium">Update now</span> to apply
                automatically, or run <code className="font-mono text-[11px]">jarela update</code>{" "}
                and restart manually.
              </>
            )}
          </div>
          {phase === "preview" && (
            <button
              type="button"
              onClick={applyUpdate}
              className="shrink-0 inline-flex items-center gap-1 rounded bg-emerald-700/40 px-2 py-0.5 text-[11px] font-medium hover:bg-emerald-700/60"
            >
              <RefreshCw size={11} />
              Update now
            </button>
          )}
          {phase !== "preview" && phase !== "failed" && (
            <RefreshCw size={14} className="mt-0.5 shrink-0 animate-spin" aria-hidden />
          )}
          {phase === "preview" && (
            <button
              type="button"
              onClick={() => {
                const key =
                  isMain && info.latestCommit?.sha
                    ? `${info.latest}@${info.latestCommit.sha}`
                    : info.latest;
                if (key) localStorage.setItem(DISMISS_KEY, key);
                setDismissed(true);
              }}
              className="shrink-0 rounded p-0.5 hover:bg-emerald-900/40"
              aria-label="Dismiss update notice"
            >
              <X size={14} />
            </button>
          )}
        </div>
        {(lines.length > 0 || errorMsg) && (
          <div className="ml-6 mt-1 max-h-32 overflow-y-auto rounded bg-emerald-950/40 px-2 py-1 font-mono text-[10px] leading-snug text-emerald-100/80">
            {errorMsg && <div className="text-rose-300">{errorMsg}</div>}
            {lines.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {l}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
