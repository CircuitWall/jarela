"use client";

import { ChevronRight } from "lucide-react";

export interface CollapseChevronProps {
  open: boolean;
  size?: number;
  className?: string;
  "aria-hidden"?: boolean;
}

/**
 * Right-pointing chevron that rotates 90deg when `open`. Use as the leading
 * affordance of an expandable trigger (button/summary) row. The trigger
 * itself owns aria-expanded; this icon is decorative.
 */
export function CollapseChevron({
  open,
  size = 11,
  className,
  "aria-hidden": ariaHidden = true,
}: CollapseChevronProps) {
  const composed = [
    "shrink-0 transition-transform",
    open ? "rotate-90" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return <ChevronRight size={size} className={composed} aria-hidden={ariaHidden} />;
}
