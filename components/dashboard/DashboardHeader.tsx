"use client";
import { CalendarClock, Check, RotateCw } from "lucide-react";
import type { DashboardPricingTaskStatus } from "@/api/types";
import { WINDOWS, type WindowDays } from "./dashboard-constants";

interface DashboardHeaderProps {
  days: WindowDays;
  onDaysChange: (d: WindowDays) => void;
  refreshingPricing: boolean;
  refreshHint: string | null;
  onRefreshPricing: () => void;
  pricingTask: DashboardPricingTaskStatus | null;
  settingUpPricingTask: boolean;
  pricingTaskHint: string | null;
  onSetupPricingTask: () => void;
}

export function DashboardHeader({ days, onDaysChange, refreshingPricing, refreshHint, onRefreshPricing, pricingTask, settingUpPricingTask, pricingTaskHint, onSetupPricingTask }: DashboardHeaderProps) {
  const pricingTaskTitle = pricingTask?.next_run_at
    ? `Assigned to ${pricingTask.task_agent_name ?? "unavailable agent"}; next run ${new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: pricingTask.time_zone,
      }).format(new Date(pricingTask.next_run_at))} (${pricingTask.time_zone})`
    : "Weekly LLM pricing maintenance task";
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
        {pricingTask?.configured && pricingTask.enabled ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]" title={pricingTaskTitle}>
            <Check size={13} />
            Weekly updates on
          </span>
        ) : pricingTask ? (
          <button
            type="button"
            onClick={onSetupPricingTask}
            disabled={settingUpPricingTask || !pricingTask.default_agent_configured}
            title={pricingTask.default_agent_configured ? "Schedule weekly pricing updates for the default agent" : "Configure a default agent first"}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 px-3 py-1.5 text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-primary)] disabled:cursor-not-allowed disabled:opacity-55"
          >
            <CalendarClock size={13} />
            {settingUpPricingTask ? "Setting up..." : pricingTask.configured ? "Resume weekly updates" : "Set up weekly updates"}
          </button>
        ) : null}
      </div>
      {refreshHint ? <p className="mt-2 text-[11px] text-[var(--text-secondary)]">{refreshHint}</p> : null}
      {pricingTaskHint ? <p className="mt-2 text-[11px] text-[var(--text-secondary)]">{pricingTaskHint}</p> : null}
      {pricingTask && !pricingTask.configured && !pricingTask.default_agent_configured ? (
        <p className="mt-2 text-[11px] text-[var(--text-secondary)]">Set a default agent to enable weekly updates.</p>
      ) : null}
    </div>
  );
}
