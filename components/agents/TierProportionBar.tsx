"use client";
// ADR-0043. Stacked-bar slider for the hot / warm / facts context split.
// Two drag handles divide a single 100%-wide bar into three coloured
// segments — hot on the left, warm in the middle, facts on the right.
// Dragging a handle redistributes the percentage between the segment to
// its left and the one to its right; the third segment is unaffected.
//
// The user never has to reconcile to 100: the bar IS 100 by construction.
// Backend `normalizeTierProportions` divides by sum, so we send the raw
// percentages and they round-trip cleanly.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface TierValue {
  hot: number;
  warm: number;
  facts: number;
}

interface Props {
  value: TierValue;
  onChange: (next: TierValue) => void;
  /** Disables drag and dims the bar. Useful when the parent shows it as a
   *  read-only preview (e.g. while inheriting from the model). */
  readOnly?: boolean;
}

const MIN_SEGMENT = 5; // %; below this a segment becomes unhittable
const MAX_SEGMENT_END = 100 - MIN_SEGMENT;

export function TierProportionBar({ value, onChange, readOnly = false }: Props) {
  const barRef = useRef<HTMLDivElement>(null);

  // Normalise to integer percentages summing to 100. The bar wants exact
  // arithmetic — fractional values create gaps and accumulate drift on drag.
  const normalised = useMemo(() => normaliseToHundred(value), [value]);
  const hotEnd = normalised.hot;
  const warmEnd = normalised.hot + normalised.warm;

  const [activeHandle, setActiveHandle] = useState<null | "hot-warm" | "warm-facts">(null);

  const onPointerDown = useCallback(
    (handle: "hot-warm" | "warm-facts") => (e: React.PointerEvent) => {
      if (readOnly) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setActiveHandle(handle);
    },
    [readOnly],
  );

  useEffect(() => {
    if (!activeHandle) return;
    const bar = barRef.current;
    if (!bar) return;

    const handleMove = (e: PointerEvent) => {
      const rect = bar.getBoundingClientRect();
      const xPct = clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100);
      onChange(updateAt(activeHandle, xPct, normalised));
    };
    const handleUp = () => setActiveHandle(null);

    document.addEventListener("pointermove", handleMove);
    document.addEventListener("pointerup", handleUp);
    document.addEventListener("pointercancel", handleUp);
    return () => {
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("pointerup", handleUp);
      document.removeEventListener("pointercancel", handleUp);
    };
  }, [activeHandle, normalised, onChange]);

  // Keyboard arrow support on each handle: 1% nudges, Shift+arrow = 5%.
  const onKeyDown = useCallback(
    (handle: "hot-warm" | "warm-facts") => (e: React.KeyboardEvent) => {
      if (readOnly) return;
      const step = e.shiftKey ? 5 : 1;
      let delta = 0;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") delta = step;
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") delta = -step;
      else return;
      e.preventDefault();
      const target = handle === "hot-warm" ? hotEnd + delta : warmEnd + delta;
      onChange(updateAt(handle, target, normalised));
    },
    [readOnly, hotEnd, warmEnd, normalised, onChange],
  );

  const dim = readOnly ? "opacity-60" : "";

  return (
    <div className={`space-y-2 ${dim}`}>
      {/* Tier label chips above the bar — live as the user drags */}
      <div className="grid grid-cols-3 gap-1 text-[10px] font-medium uppercase tracking-wider">
        <Chip color="accent" label="Hot" pct={normalised.hot} />
        <Chip color="amber" label="Warm" pct={normalised.warm} centered />
        <Chip color="teal" label="Facts" pct={normalised.facts} right />
      </div>

      {/* The bar itself */}
      <div
        ref={barRef}
        className="relative h-6 rounded-full bg-surface-3 border border-border overflow-hidden select-none"
        role="group"
        aria-label="Context tier proportions"
      >
        <div
          className="absolute inset-y-0 left-0 bg-accent/70"
          style={{ width: `${hotEnd}%` }}
          aria-hidden
        />
        <div
          className="absolute inset-y-0 bg-amber-500/70"
          style={{ left: `${hotEnd}%`, width: `${normalised.warm}%` }}
          aria-hidden
        />
        <div
          className="absolute inset-y-0 bg-teal-500/70"
          style={{ left: `${warmEnd}%`, right: 0 }}
          aria-hidden
        />

        <Handle
          left={hotEnd}
          active={activeHandle === "hot-warm"}
          readOnly={readOnly}
          onPointerDown={onPointerDown("hot-warm")}
          onKeyDown={onKeyDown("hot-warm")}
          ariaLabel="Hot ↔ Warm split"
          ariaValueNow={hotEnd}
          ariaValueMin={MIN_SEGMENT}
          ariaValueMax={warmEnd - MIN_SEGMENT}
        />
        <Handle
          left={warmEnd}
          active={activeHandle === "warm-facts"}
          readOnly={readOnly}
          onPointerDown={onPointerDown("warm-facts")}
          onKeyDown={onKeyDown("warm-facts")}
          ariaLabel="Warm ↔ Facts split"
          ariaValueNow={warmEnd}
          ariaValueMin={hotEnd + MIN_SEGMENT}
          ariaValueMax={MAX_SEGMENT_END}
        />
      </div>

      {/* Explainer — surfaces what each tier means to the agent so the user
          isn't dragging blind. The bar represents the share of the input
          context budget; growing one tier shrinks the others. */}
      <div className="rounded-lg border border-border bg-surface-3/50 p-2.5 space-y-1.5">
        <p className="text-[11px] font-semibold text-fg-subtle">
          What changes when you drag
        </p>
        <ul className="text-[11px] text-fg-muted space-y-1">
          <li>
            <span className="inline-block w-12 font-medium text-accent">Hot</span>
            Verbatim recent messages. More hot = the agent has more of this
            exact conversation in front of it.
          </li>
          <li>
            <span className="inline-block w-12 font-medium text-amber-500">Warm</span>
            A summary of older messages outside the hot window. More warm =
            better long-term recall of how we got here, less raw detail.
          </li>
          <li>
            <span className="inline-block w-12 font-medium text-teal-500">Facts</span>
            Hits from saved memory (preferences, domain notes). More facts =
            the agent draws on what you&apos;ve taught it across threads.
          </li>
        </ul>
        <p className="text-[10px] text-fg-faint pt-0.5">
          The bar is always 100% of the agent&apos;s input budget, so growing
          one tier shrinks the others. Arrow keys nudge by 1% (Shift+arrow
          by 5%).
        </p>
      </div>
    </div>
  );
}

function Chip({
  color,
  label,
  pct,
  centered,
  right,
}: {
  color: "accent" | "amber" | "teal";
  label: string;
  pct: number;
  centered?: boolean;
  right?: boolean;
}) {
  const colorMap = {
    accent: "text-accent bg-accent/10 border-accent/30",
    amber: "text-amber-500 bg-amber-500/10 border-amber-500/30",
    teal: "text-teal-500 bg-teal-500/10 border-teal-500/30",
  } as const;
  const align = centered ? "justify-center" : right ? "justify-end" : "justify-start";
  return (
    <div className={`flex ${align}`}>
      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border ${colorMap[color]}`}>
        <span>{label}</span>
        <span className="font-mono normal-case tracking-normal">{Math.round(pct)}%</span>
      </span>
    </div>
  );
}

function Handle({
  left,
  active,
  readOnly,
  ariaLabel,
  ariaValueNow,
  ariaValueMin,
  ariaValueMax,
  onPointerDown,
  onKeyDown,
}: {
  left: number;
  active: boolean;
  readOnly: boolean;
  ariaLabel: string;
  ariaValueNow: number;
  ariaValueMin: number;
  ariaValueMax: number;
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  return (
    <div
      role="slider"
      tabIndex={readOnly ? -1 : 0}
      aria-orientation="horizontal"
      aria-label={ariaLabel}
      aria-valuenow={ariaValueNow}
      aria-valuemin={ariaValueMin}
      aria-valuemax={ariaValueMax}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      style={{ left: `calc(${left}% - 9px)` }}
      className={[
        "absolute top-1/2 -translate-y-1/2 w-[18px] h-[18px] rounded-full",
        "bg-surface border-2 shadow-md transition-colors",
        readOnly ? "border-border cursor-default" : "border-fg-muted hover:border-accent cursor-ew-resize",
        active ? "border-accent ring-2 ring-accent/30" : "",
        "focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/40",
      ].join(" ")}
    />
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// Move the chosen handle to `endPct`, clamped so each segment keeps at least
// MIN_SEGMENT %. The third tier (the one neither side of the moved handle)
// is left untouched — only the two adjacent tiers redistribute.
function updateAt(
  handle: "hot-warm" | "warm-facts",
  endPct: number,
  current: TierValue,
): TierValue {
  const hot = current.hot;
  const warm = current.warm;
  const facts = current.facts;
  if (handle === "hot-warm") {
    const minHot = MIN_SEGMENT;
    const maxHot = 100 - facts - MIN_SEGMENT;
    const newHot = Math.round(clamp(endPct, minHot, maxHot));
    return { hot: newHot, warm: 100 - newHot - facts, facts };
  } else {
    // endPct is the position of the warm-facts boundary, i.e. hot + warm.
    const minBoundary = hot + MIN_SEGMENT;
    const maxBoundary = MAX_SEGMENT_END;
    const newBoundary = Math.round(clamp(endPct, minBoundary, maxBoundary));
    return { hot, warm: newBoundary - hot, facts: 100 - newBoundary };
  }
}

// Map any positive numbers to integer percents summing to exactly 100. Falls
// back to defaults on a zero/negative sum so the UI never displays an empty
// bar. Drift from rounding is absorbed by `facts` (the residual).
function normaliseToHundred(v: TierValue): TierValue {
  const sum = (Number(v.hot) || 0) + (Number(v.warm) || 0) + (Number(v.facts) || 0);
  if (sum <= 0) return { hot: 60, warm: 25, facts: 15 };
  const hot = Math.round((Number(v.hot) / sum) * 100);
  const warm = Math.round((Number(v.warm) / sum) * 100);
  return { hot, warm, facts: 100 - hot - warm };
}
