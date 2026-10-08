import type { ReactNode } from "react";

const TONES = {
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200",
  error: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  info: "border-border bg-surface-2/60 text-fg-muted",
} as const;

export function Notice({ tone = "info", children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return (
    <div role={tone === "error" ? "alert" : undefined} className={`rounded-lg border px-3 py-2 text-[11px] leading-snug ${TONES[tone]}`}>
      {children}
    </div>
  );
}
