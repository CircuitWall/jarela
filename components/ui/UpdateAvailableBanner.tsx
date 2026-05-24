"use client";

// Surfaces a dismissible banner when the running version is behind the latest
// published to npm. Backed by /api/v1/update.

import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";

type UpdateInfo = {
  channel?: "stable" | "main";
  current: string;
  latest: string | null;
  behind: boolean;
  latestCommit?: { sha: string; date: string | null };
  currentCommit?: string;
};

const DISMISS_KEY = "jarela:update-banner-dismissed-for";

export function UpdateAvailableBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/update")
      .then((r) => r.json())
      .then((j: UpdateInfo) => {
        if (cancelled) return;
        if (!j?.behind || !j.latest) return;
        const dismissKey = j.channel === "main" && j.latestCommit?.sha
          ? `${j.latest}@${j.latestCommit.sha}`
          : j.latest;
        const dismissedFor =
          typeof localStorage !== "undefined" ? localStorage.getItem(DISMISS_KEY) : null;
        // Dismissals are scoped to the version/commit that was offered: once
        // a newer one ships, the banner reappears.
        if (dismissedFor === dismissKey) {
          setDismissed(true);
        }
        setInfo(j);
      })
      .catch(() => { /* update check is best-effort */ });
    return () => { cancelled = true; };
  }, []);

  if (!info || !info.behind || !info.latest || dismissed) return null;

  const isMain = info.channel === "main";
  const shortRemote = info.latestCommit?.sha?.slice(0, 7);
  const shortLocal = info.currentCommit?.slice(0, 7);
  const upgradeCmd = isMain
    ? "jarela update"
    : "jarela update";
  const altCmd = isMain
    ? "npm i -g github:CircuitWall/jarela#main"
    : "npm i -g @circuitwall/jarela@latest";

  return (
    <div
      className="fixed left-0 right-0 z-30 px-3 pt-2 pointer-events-none"
      style={{ top: "calc(3rem + var(--app-safe-top))" }}
    >
      <div className="mx-auto max-w-4xl pointer-events-auto flex items-start gap-2 border border-emerald-900/40 rounded-lg bg-emerald-950/60 backdrop-blur px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">
        <Download size={14} className="mt-0.5 shrink-0" />
        <div className="flex-1">
          <span className="font-medium">
            {isMain ? "Experimental update available:" : "Update available:"}
          </span>{" "}
          {isMain && shortRemote
            ? <>{shortLocal ?? info.current} → {shortRemote} ({info.latest}).</>
            : <>{info.current} → {info.latest}.</>}
          {" "}
          Run <code className="font-mono text-[11px]">{upgradeCmd}</code>{" "}
          (or <code className="font-mono text-[11px]">{altCmd}</code>) and restart.
        </div>
        <button
          type="button"
          onClick={() => {
            const key = isMain && info.latestCommit?.sha
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
      </div>
    </div>
  );
}
