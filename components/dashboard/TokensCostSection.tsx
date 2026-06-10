"use client";
import type { DashboardCurrencyInfo, DashboardMetrics } from "@/api/types";
import { InteractiveCostChart, InteractiveTokenChart } from "./Series";

interface TokensCostSectionProps {
  series: DashboardMetrics["series"];
  currencyInfo: DashboardCurrencyInfo;
  selectedDay: string | null;
  onToggleDay: (day: string) => void;
  onClearDay: () => void;
}

export function TokensCostSection({ series, currencyInfo, selectedDay, onToggleDay, onClearDay }: TokensCostSectionProps) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-[var(--text-primary)]">Tokens &amp; cost over time</h3>
        {selectedDay ? (
          <button
            type="button"
            onClick={onClearDay}
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2.5 py-1 text-[11px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent)]/20"
            aria-label="Clear day selection"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
            Showing breakdown for {selectedDay} · clear
          </button>
        ) : (
          <span className="text-[11px] text-[var(--text-secondary)]">Click a day to narrow the breakdown</span>
        )}
      </div>
      <InteractiveTokenChart series={series} selectedDay={selectedDay} onSelectDay={onToggleDay} />
      <div className="mt-3 border-t border-[var(--border)]/60 pt-3">
        <InteractiveCostChart series={series} currencyInfo={currencyInfo} selectedDay={selectedDay} onSelectDay={onToggleDay} />
      </div>
    </section>
  );
}
