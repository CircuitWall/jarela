"use client";

import type { ReactNode } from "react";

export type BadgeTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "accent";

export type BadgeSize = "xs" | "sm";

const TONE_BG: Record<BadgeTone, string> = {
  neutral: "bg-surface-3 text-fg-muted",
  success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  danger: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  info: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  accent: "bg-accent/15 text-accent",
};

const TONE_BORDER: Record<BadgeTone, string> = {
  neutral: "border-border",
  success: "border-emerald-500/30",
  warning: "border-amber-500/30",
  danger: "border-rose-500/30",
  info: "border-sky-500/30",
  accent: "border-accent/40",
};

const SIZE_CLASS: Record<BadgeSize, string> = {
  xs: "h-4 px-1.5 text-[10px] gap-0.5",
  sm: "px-2 py-0.5 text-[11px] gap-1",
};

export interface BadgeProps {
  tone?: BadgeTone;
  size?: BadgeSize;
  bordered?: boolean;
  icon?: ReactNode;
  className?: string;
  title?: string;
  children?: ReactNode;
}

export function Badge({
  tone = "neutral",
  size = "xs",
  bordered = false,
  icon,
  className,
  title,
  children,
}: BadgeProps) {
  const composed = [
    "inline-flex items-center shrink-0 rounded-full font-medium",
    TONE_BG[tone],
    SIZE_CLASS[size],
    bordered ? `border ${TONE_BORDER[tone]}` : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={composed} title={title}>
      {icon}
      {children}
    </span>
  );
}
