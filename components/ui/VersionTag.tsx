"use client";

// Small subdued badge that shows the running Jarela version. Reads from
// /api/v1/update, which is already the source of truth for the update
// banner, so the number here matches what the "Update available" banner
// compares against.

import { useEffect, useState } from "react";

type UpdateInfo = { current?: string };

export function VersionTag({ className = "" }: { className?: string }) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/update")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: UpdateInfo | null) => {
        if (cancelled) return;
        if (j?.current) setVersion(j.current);
      })
      .catch(() => { /* best-effort */ });
    return () => { cancelled = true; };
  }, []);

  if (!version) return null;
  return (
    <span className={`text-[11px] text-fg-faint/70 tabular-nums select-none ${className}`}>
      v{version}
    </span>
  );
}
