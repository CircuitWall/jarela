"use client";

import type { CSSProperties } from "react";

export type StatusTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "accent";

export type StatusSize = "xs" | "sm";

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: "bg-fg-faint",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
  info: "bg-sky-500",
  accent: "bg-accent",
};

const SIZE_CLASS: Record<StatusSize, string> = {
  xs: "w-1.5 h-1.5",
  sm: "w-2 h-2",
};

export interface StatusDotProps {
  tone?: StatusTone;
  size?: StatusSize;
  pulse?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Accessible label. When provided, role=img is set; otherwise the dot is aria-hidden. */
  label?: string;
  /** Native tooltip text. */
  title?: string;
}

export function StatusDot({
  tone = "neutral",
  size = "xs",
  pulse,
  className,
  style,
  label,
  title,
}: StatusDotProps) {
  const composed = [
    "inline-block shrink-0 rounded-full",
    TONE_CLASS[tone],
    SIZE_CLASS[size],
    pulse ? "animate-pulse" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return label ? (
    <span role="img" aria-label={label} title={title} className={composed} style={style} />
  ) : (
    <span aria-hidden title={title} className={composed} style={style} />
  );
}
