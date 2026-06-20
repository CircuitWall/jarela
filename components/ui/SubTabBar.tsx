"use client";

import type { ReactNode } from "react";

// Shared horizontal sub-tab strip used by Settings / Tools / Credentials.
// Two iOS-Safari-PWA contracts the hand-rolled strips kept getting wrong:
//   - tabs MUST be `shrink-0` so the strip overflows when the labels
//     don't fit, otherwise flexbox compresses them and there is nothing
//     for the user to scroll to.
//   - container MUST have `touch-pan-x` so horizontal swipes scroll the
//     strip while vertical swipes bubble up to scroll the page. With
//     `pan-y` the browser only consumes vertical panning on this element
//     and horizontal swipes do nothing — the strip looked stuck.

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
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex items-stretch gap-4 px-4 border-b border-[var(--border)] bg-[var(--bg-secondary)] overflow-x-auto no-scrollbar select-none touch-pan-x"
    >
      {tabs.map((t) => {
        const selected = t.id === active;
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
            onClick={() => onChange(t.id)}
            className={
              "shrink-0 inline-flex items-center gap-1.5 py-2.5 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors " +
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
  );
}
