"use client";
import type { DashboardCurrencyInfo, DashboardMetrics } from "@/api/types";
import { formatInt } from "@/lib/dashboard/format";
import { BreakdownPiePanel } from "./Donuts";

interface VendorModelReportSectionProps {
  effectiveByProvider: DashboardMetrics["by_provider"];
  effectiveByModel: DashboardMetrics["by_model"];
  selectedDay: string | null;
  currencyInfo: DashboardCurrencyInfo;
}

export function VendorModelReportSection({ effectiveByProvider, effectiveByModel, selectedDay, currencyInfo }: VendorModelReportSectionProps) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-4 space-y-3 shadow-sm">
      <h3 className="text-sm font-medium text-[var(--text-primary)]">
        Vendor and model report
        {selectedDay ? <span className="ml-2 text-[11px] text-[var(--text-secondary)]">scoped to {selectedDay}</span> : null}
      </h3>
      <div className="grid lg:grid-cols-2 gap-3">
        <BreakdownPiePanel
          key={`vendor-${selectedDay ?? "all"}`}
          title="By vendor"
          emptyLabel={selectedDay ? `No vendor activity on ${selectedDay}.` : "No vendor breakdown data yet."}
          items={effectiveByProvider.slice(0, 12).map((row) => ({
            id: row.provider,
            label: row.provider,
            cost: row.estimated_cost_usd,
            detail: `${formatInt(row.message_count)} msgs · ${formatInt(row.input_tokens_est + row.output_tokens_est)} tokens`,
          }))}
          currencyInfo={currencyInfo}
        />
        <BreakdownPiePanel
          key={`model-${selectedDay ?? "all"}`}
          title="By model config"
          emptyLabel={selectedDay ? `No model activity on ${selectedDay}.` : "No model breakdown data yet."}
          items={effectiveByModel.slice(0, 16).map((row) => ({
            id: `${row.provider}:${row.model_config_name}:${row.model_id}`,
            label: row.model_config_name,
            cost: row.estimated_cost_usd,
            detail: `${row.provider}/${row.model_id} · ${formatInt(row.message_count)} msgs`,
          }))}
          currencyInfo={currencyInfo}
        />
      </div>
    </section>
  );
}
