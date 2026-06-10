"use client";
import { RotateCw } from "lucide-react";
import { WINDOWS, type WindowDays } from "./dashboard-constants";

interface DashboardHeaderProps {
  days: WindowDays;
  onDaysChange: (d: WindowDays) => void;
  refreshingPricing: boolean;
  refreshHint: string | null;
  onRefreshPricing: () => void;
}

export function DashboardHeader({ days, onDaysChange, refreshingPricing, refreshHint, onRefreshPricing }: DashboardHeaderProps) {
  return (
    <div className="sticky top-0 z-20 -mx-4 md:-mx-6 -mt-4 md:-mt-6 mb-2 border-b border-[var(--border)] bg-[var(--bg-primary)]/85 px-4 md:px-6 py-3 md:py-4 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.45)] backdrop-blur-xl backdrop-saturate-150 supports-[backdrop-filter]:bg-[var(--bg-primary)]/70 [mask-image:linear-gradient(to_bottom,black_85%,transparent)] [-webkit-mask-image:linear-gradient(to_bottom,black_85%,transparent)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">Usage dashboard</h2>
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            Cost, token flow, and reliability across your configured models.
          </p>
        </div>
        <div className="inline-flex rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-1 shadow-sm">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => onDaysChange(w)}
              className={
                "px-2.5 py-1 text-xs rounded-lg transition-colors " +
                (w === days
                  ? "bg-[var(--accent)] text-white shadow-sm"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-primary)]")
              }
            >
              {w}d
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onRefreshPricing}
          disabled={refreshingPricing}
          className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 px-3 py-1.5 text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-primary)] disabled:opacity-60"
        >
          <RotateCw size={13} className={refreshingPricing ? "animate-spin" : ""} />
          {refreshingPricing ? "Refreshing..." : "Refresh pricing"}
        </button>
      </div>
      {refreshHint ? <p className="mt-2 text-[11px] text-[var(--text-secondary)]">{refreshHint}</p> : null}
    </div>
  );
}
