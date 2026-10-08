"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

// Shared horizontal sub-tab strip used by Settings / Tools / Credentials.
// Two iOS-Safari-PWA contracts the hand-rolled strips kept getting wrong:
//   - tabs MUST be `shrink-0` so the strip overflows when the labels
//     don't fit, otherwise flexbox compresses them and there is nothing
//     for the user to scroll to.
//   - container MUST have `touch-pan-x` so horizontal swipes scroll the
//     strip while vertical swipes bubble up to scroll the page. With
//     `pan-y` the browser only consumes vertical panning on this element
//     and horizontal swipes do nothing — the strip looked stuck.
// The scrollbar is hidden, so mouse users get wheel-to-horizontal mapping and
// edge arrows that appear only while there is more to reveal.

export interface SubTabItem<T extends string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
}

export interface SubTabBarProps<T extends string> {
  tabs: ReadonlyArray<SubTabItem<T>>;
  active: T;
  onChange: (id: T) => void;
  ariaLabel: string;
}

export function SubTabBar<T extends string>({
  tabs,
  active,
  onChange,
  ariaLabel,
}: SubTabBarProps<T>) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    // Vertical wheel ticks scroll the strip sideways; trackpad horizontal
    // gestures (deltaX) are left alone, and the page scrolls normally once
    // the strip hits an end.
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      const atEdge = (e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max);
      if (atEdge) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("scroll", measure);
      el.removeEventListener("wheel", onWheel);
      ro?.disconnect();
    };
  }, [measure, tabs.length]);

  // Reveal the active tab by moving only the strip; scrollIntoView can also
  // scroll ancestors and jump the page.
  useEffect(() => {
    const el = scrollerRef.current;
    const tab = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el || !tab) return;
    const left = tab.offsetLeft - 32;
    const right = tab.offsetLeft + tab.offsetWidth + 32;
    if (left < el.scrollLeft) el.scrollLeft = Math.max(0, left);
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  }, [active]);

  const nudge = (dir: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: dir * el.clientWidth * 0.6, behavior: reduced ? "auto" : "smooth" });
  };

  // WAI-ARIA tabs: arrows move focus and selection, Home/End jump.
  const onKeyDown = (e: KeyboardEvent) => {
    if (tabs.length === 0) return;
    const idx = Math.max(0, tabs.findIndex((t) => t.id === active));
    let next = -1;
    if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].id);
    scrollerRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div className="relative bg-[var(--bg-secondary)]">
      <div
        ref={scrollerRef}
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        className="flex items-stretch gap-4 px-4 border-b border-[var(--border)] overflow-x-auto overscroll-x-contain no-scrollbar select-none touch-pan-x"
      >
        {tabs.map((t, i) => {
          const selected = t.id === active;
          // Keep the strip reachable by keyboard even if `active` isn't listed.
          const tabbable = selected || (i === 0 && !tabs.some((x) => x.id === active));
          // Pin the accessible name to the textual label so a transient
          // badge (StatusDot with aria-label="Needs setup") can't append
          // to the tab's accessible name and break `getByRole("tab",
          // { name, exact: true })` once the attention hook resolves.
          const ariaLabelText = typeof t.label === "string" ? t.label : undefined;
          return (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-label={ariaLabelText}
              tabIndex={tabbable ? 0 : -1}
              onClick={() => onChange(t.id)}
              className={
                "control-tap touch-manipulation shrink-0 inline-flex items-center gap-1.5 py-2.5 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent " +
                (selected
                  ? "border-[var(--accent)] text-[var(--text-primary)] font-medium"
                  : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]")
              }
            >
              {t.icon && <span className="text-fg-subtle">{t.icon}</span>}
              <span>{t.label}</span>
              {t.badge}
            </button>
          );
        })}
      </div>
      {canLeft && <EdgeArrow side="left" onClick={() => nudge(-1)} />}
      {canRight && <EdgeArrow side="right" onClick={() => nudge(1)} />}
    </div>
  );
}

function EdgeArrow({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      onClick={onClick}
      className={
        "absolute inset-y-0 w-8 flex items-center pointer-coarse:hidden text-fg-muted hover:text-fg from-[var(--bg-secondary)] via-[var(--bg-secondary)] to-transparent " +
        (side === "left"
          ? "bg-gradient-to-r left-0 justify-start pl-1"
          : "bg-gradient-to-l right-0 justify-end pr-1")
      }
    >
      <Icon size={14} />
    </button>
  );
}
