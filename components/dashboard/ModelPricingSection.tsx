"use client";
import type { DashboardCurrencyInfo, DashboardMetrics } from "@/api/types";
import { detectModelFunctionality } from "@/lib/dashboard/classify";
import { formatMoney, safeHttpUrl } from "@/lib/dashboard/format";
import { ProviderLogo } from "@/components/models/ProviderLogo";
import {
  filterModelRates,
  groupModelRatesByVendor,
  sortModelRates,
  type ModelSort,
} from "@/lib/dashboard/sort";
import { MODEL_SORT_OPTIONS } from "./dashboard-constants";

interface ModelPricingSectionProps {
  data: DashboardMetrics;
  modelVendorFilter: string;
  onVendorFilterChange: (v: string) => void;
  modelFunctionFilter: string;
  onFunctionFilterChange: (v: string) => void;
  modelSearch: string;
  onSearchChange: (v: string) => void;
  modelSort: ModelSort;
  onSortChange: (s: ModelSort) => void;
  currencyInfo: DashboardCurrencyInfo;
}

export function ModelPricingSection({
  data,
  modelVendorFilter,
  onVendorFilterChange,
  modelFunctionFilter,
  onFunctionFilterChange,
  modelSearch,
  onSearchChange,
  modelSort,
  onSortChange,
  currencyInfo,
}: ModelPricingSectionProps) {
  const filtered = sortModelRates(
    filterModelRates(data.pricing.model_rates, {
      vendor: modelVendorFilter,
      functionality: modelFunctionFilter,
      search: modelSearch,
    }),
    modelSort,
  );
  const grouped = groupModelRatesByVendor(filtered);
  const vendors = [...new Set(data.pricing.model_rates.map((r) => r.provider))].sort();
  const functionalities = [...new Set(data.pricing.model_rates.map((r) => detectModelFunctionality(r.model_id)))].sort();

  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-4 space-y-2 shadow-sm">
      <h3 className="text-sm font-medium text-[var(--text-primary)]">Pricing source and assumptions</h3>
      <p className="text-xs text-[var(--text-secondary)]">
        Snapshot: {data.pricing.snapshot_generated_at ?? "not found"}
      </p>
      <div className="rounded-lg bg-[var(--bg-primary)]/25 overflow-hidden">
        <div className="px-3 py-2 text-xs font-medium text-[var(--text-primary)]">
          Model pricing (detected)
        </div>
        <div className="px-3 pb-2">
          <div className="grid gap-2 md:grid-cols-[160px_160px_1fr_190px]">
            <select
              value={modelVendorFilter}
              onChange={(e) => onVendorFilterChange(e.target.value)}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]"
              style={{ color: "var(--text-primary)", backgroundColor: "var(--bg-primary)" }}
            >
              <option value="all" style={{ color: "var(--text-primary)", backgroundColor: "var(--bg-secondary)" }}>All vendors</option>
              {vendors.map((provider) => (
                <option key={provider} value={provider} style={{ color: "var(--text-primary)", backgroundColor: "var(--bg-secondary)" }}>
                  {provider}
                </option>
              ))}
            </select>
            <select
              value={modelFunctionFilter}
              onChange={(e) => onFunctionFilterChange(e.target.value)}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]"
              style={{ color: "var(--text-primary)", backgroundColor: "var(--bg-primary)" }}
            >
              <option value="all" style={{ color: "var(--text-primary)", backgroundColor: "var(--bg-secondary)" }}>All functions</option>
              {functionalities.map((func) => (
                <option key={func} value={func} style={{ color: "var(--text-primary)", backgroundColor: "var(--bg-secondary)" }}>
                  {func}
                </option>
              ))}
            </select>
            <input
              value={modelSearch}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Filter models (e.g. gpt, gemini, deepseek)"
              className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]"
            />
            <select
              value={modelSort}
              onChange={(e) => onSortChange(e.target.value as ModelSort)}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]"
              style={{ color: "var(--text-primary)", backgroundColor: "var(--bg-primary)" }}
            >
              {MODEL_SORT_OPTIONS.map((opt) => (
                <option
                  key={opt.value}
                  value={opt.value}
                  style={{ color: "var(--text-primary)", backgroundColor: "var(--bg-secondary)" }}
                >
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="max-h-72 overflow-auto">
          {filtered.length === 0 ? (
            <p className="p-3 text-xs text-[var(--text-secondary)]">No model rates match the selected filters.</p>
          ) : (
            grouped.map(([provider, rows]) => (
              <ModelPricingGroup key={provider} provider={provider} rows={rows} currencyInfo={currencyInfo} />
            ))
          )}
        </div>
      </div>
      <p className="text-[11px] text-[var(--text-secondary)]">{data.pricing.notes}</p>
    </section>
  );
}

function ModelPricingGroup({ provider, rows, currencyInfo }: { provider: string; rows: DashboardMetrics["pricing"]["model_rates"]; currencyInfo: DashboardCurrencyInfo }) {
  return (
    <div className="border-b border-[var(--border)]/60 last:border-b-0">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-l-2 border-l-[var(--accent)] bg-[var(--bg-secondary)]/95 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-primary)] backdrop-blur">
        <span className="inline-flex items-center gap-1.5">
          <span className="text-[var(--text-secondary)]"><ProviderLogo name={provider} size={14} /></span>
          {provider}
        </span>
        <span className="rounded-full border border-[var(--border)] bg-[var(--bg-primary)]/60 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-[var(--text-secondary)]">
          {rows.length} model{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      {rows.map((row) => (
        <ModelPricingRow key={`${row.provider}:${row.model_id}`} row={row} currencyInfo={currencyInfo} />
      ))}
    </div>
  );
}

function ModelPricingRow({ row, currencyInfo }: { row: DashboardMetrics["pricing"]["model_rates"][number]; currencyInfo: DashboardCurrencyInfo }) {
  const inputLabel = typeof row.input_per_1m_usd === "number" && Number.isFinite(row.input_per_1m_usd)
    ? formatMoney(row.input_per_1m_usd, currencyInfo)
    : "n/a";
  const outputLabel = typeof row.output_per_1m_usd === "number" && Number.isFinite(row.output_per_1m_usd)
    ? formatMoney(row.output_per_1m_usd, currencyInfo)
    : "n/a";
  return (
    <div className="px-3 py-2 border-t border-[var(--border)]/40 hover:bg-[var(--bg-primary)]/35 transition-colors">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-[var(--text-primary)] truncate">{row.model_id}</span>
        <span className="text-[11px] tabular-nums text-[var(--text-secondary)]" title="Per 1M tokens">
          in <span className="text-[var(--text-primary)]">{inputLabel}</span>
          {" · "}out <span className="text-[var(--text-primary)]">{outputLabel}</span>
          <span className="ml-1 text-[var(--text-secondary)]">/ 1M</span>
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className={`rounded-full px-1.5 py-0.5 font-medium ${
          row.inferred
            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
            : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
        }`}>
          {row.inferred ? "inferred" : "explicit"}
        </span>
        <span className={`rounded-full px-1.5 py-0.5 font-medium ${
          row.confidence === "high"
            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : row.confidence === "medium"
            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
            : "bg-rose-500/15 text-rose-700 dark:text-rose-300"
        }`}>
          {row.confidence}
        </span>
        <span className="rounded-full bg-[var(--bg-primary)]/60 px-1.5 py-0.5 text-[var(--text-secondary)]">
          {detectModelFunctionality(row.model_id)}
        </span>
        {safeHttpUrl(row.source) ? (
          <a
            href={row.source}
            target="_blank"
            rel="noreferrer"
            className="ml-auto rounded-full bg-cyan-500/15 px-1.5 py-0.5 text-cyan-700 hover:bg-cyan-500/25 dark:text-cyan-300"
          >
            source ↗
          </a>
        ) : null}
      </div>
    </div>
  );
}
