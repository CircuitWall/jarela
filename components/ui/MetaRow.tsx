"use client";
import type { ReactNode } from "react";

export type MetaRowAccent = "amber" | "emerald" | "sky" | "neutral";

// Per-accent border + text + hover tint. Background and shape are shared.
const ACCENT: Record<MetaRowAccent, string> = {
  amber:   "border-amber-400/20 text-amber-700/80 dark:text-amber-300/60 hover:bg-amber-400/8",
  emerald: "border-emerald-400/20 text-emerald-700/80 dark:text-emerald-300/70 hover:bg-emerald-400/8",
  sky:     "border-sky-400/20 text-sky-700/80 dark:text-sky-300/60 hover:bg-sky-400/8",
  neutral: "border-border/40 text-fg-faint hover:bg-surface-3/40",
};

/**
 * Shared visual base for all inline chat metadata rows: thinking, tool calls,
 * routing decisions. Consistent shape, density, and colour vocabulary.
 */
export function MetaRow({
  children,
  accent = "neutral",
  onClick,
  expanded,
  title,
  "aria-label": ariaLabel,
  fullWidth = false,
  className,
}: {
  children: ReactNode;
  accent?: MetaRowAccent;
  onClick?: () => void;
  expanded?: boolean;
  title?: string;
  "aria-label"?: string;
  fullWidth?: boolean;
  className?: string;
}) {
  const cls = [
    fullWidth ? "w-full flex text-left" : "inline-flex",
    "min-w-0 max-w-full items-center gap-1.5 rounded border bg-surface-2/40 px-2 py-0.5 text-[10px] transition-colors",
    ACCENT[accent],
    className ?? "",
  ].filter(Boolean).join(" ");

  return (
    <button
      type="button"
      onClick={onClick}
      className={cls}
      title={title}
      aria-label={ariaLabel}
      aria-expanded={expanded}
    >
      {children}
    </button>
  );
}

export function MetaDetailPanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const cls = [
    "mt-0.5 rounded border border-border/40 bg-surface-2/35 px-2 py-1.5 text-[10px] text-fg-muted",
    className ?? "",
  ].filter(Boolean).join(" ");

  return <div className={cls}>{children}</div>;
}
