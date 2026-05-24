"use client";

// Surfaces a dismissible banner when the running version is behind the latest
// published to npm. Backed by /api/v1/update.

import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";

type UpdateInfo = {
  current: string;
  latest: string | null;
  behind: boolean;
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
        const dismissedFor =
          typeof localStorage !== "undefined" ? localStorage.getItem(DISMISS_KEY) : null;
        // Dismissals are scoped to the version that was offered: once a newer
        // one ships, the banner reappears.
        if (dismissedFor === j.latest) {
          setDismissed(true);
        }
        setInfo(j);
      })
      .catch(() => { /* update check is best-effort */ });
    return () => { cancelled = true; };
  }, []);

  if (!info || !info.behind || !info.latest || dismissed) return null;

  return (
    <div
      className="fixed left-0 right-0 z-30 px-3 pt-2 pointer-events-none"
      style={{ top: "calc(3rem + var(--app-safe-top))" }}
    >
      <div className="mx-auto max-w-4xl pointer-events-auto flex items-start gap-2 border border-emerald-900/40 rounded-lg bg-emerald-950/60 backdrop-blur px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">
        <Download size={14} className="mt-0.5 shrink-0" />
        <div className="flex-1">
          <span className="font-medium">Update available:</span>{" "}
          {info.current} → {info.latest}.{" "}
          Run <code className="font-mono text-[11px]">jarela update</code>{" "}
          (or <code className="font-mono text-[11px]">npm i -g @circuitwall/jarela@latest</code>) and restart.
        </div>
        <button
          type="button"
          onClick={() => {
            if (info.latest) localStorage.setItem(DISMISS_KEY, info.latest);
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
