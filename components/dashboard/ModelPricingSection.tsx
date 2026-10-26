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
  pricing: DashboardMetrics["pricing"];
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
  pricing,
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
    filterModelRates(pricing.model_rates, {
      vendor: modelVendorFilter,
      functionality: modelFunctionFilter,
      search: modelSearch,
    }),
    modelSort,
  );
  const grouped = groupModelRatesByVendor(filtered);
  const vendors = [...new Set(pricing.model_rates.map((r) => r.provider))].sort();
  const functionalities = [...new Set(pricing.model_rates.map((r) => detectModelFunctionality(r.model_id)))].sort();
  const aggregatorRates = pricing.aggregator_model_rates
    .filter((row) => modelVendorFilter === "all" || row.provider === modelVendorFilter)
    .filter((row) => modelFunctionFilter === "all" || detectModelFunctionality(row.model_id) === modelFunctionFilter)
    .filter((row) => !modelSearch.trim()
      || `${row.provider} ${row.model_id} ${row.aggregator_model_id}`.toLowerCase().includes(modelSearch.trim().toLowerCase()));

  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-4 space-y-2 shadow-sm">
      <h3 className="text-sm font-medium text-[var(--text-primary)]">Pricing source and assumptions</h3>
      <p className="text-xs text-[var(--text-secondary)]">
        Snapshot: {pricing.snapshot_generated_at ?? "not found"}
      </p>
      <div className="rounded-lg bg-[var(--bg-primary)]/25 overflow-hidden">
        <div className="px-3 py-2 text-xs font-medium text-[var(--text-primary)]">
          Model pricing (detected)
        </div>
        <p className="px-3 pb-2 text-[11px] text-[var(--text-secondary)]">
          Separate input and output prices per 1 million tokens ({currencyInfo.currency}). Usage costs apply each rate separately.
        </p>
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
      <div className="rounded-lg bg-[var(--bg-primary)]/25 overflow-hidden">
        <div className="px-3 pt-3 text-xs font-medium text-[var(--text-primary)]">
          Aggregator reference rates
        </div>
        <p className="px-3 pt-1 text-[11px] text-[var(--text-secondary)]">
          Route-price signals only. They are not used for direct-provider cost estimates.
        </p>
        <div className="flex flex-wrap gap-1.5 px-3 py-2">
          {pricing.aggregator_sources.map((source) => (
            <span
              key={source.id}
              title={source.error ?? (source.ok ? `Last checked ${source.fetched_at}` : `Last successful fetch ${source.last_successful_at ?? "never"}`)}
              className={`rounded-full px-2 py-0.5 text-[10px] ${source.ok
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : "bg-amber-500/15 text-amber-700 dark:text-amber-300"}`}
            >
              {source.name}: {source.model_rate_count}{source.ok ? " rates" : " stale"}
            </span>
          ))}
        </div>
        <div className="max-h-56 overflow-auto">
          {aggregatorRates.length === 0 ? (
            <p className="px-3 pb-3 text-xs text-[var(--text-secondary)]">No comparable aggregator rates for these filters.</p>
          ) : (
            aggregatorRates.slice(0, 100).map((row) => {
              const direct = pricing.model_rates.find((rate) => rate.provider === row.provider && rate.model_id === row.model_id);
              const inputDelta = priceDelta(row.input_per_1m_usd, direct?.input_per_1m_usd ?? null);
              const outputDelta = priceDelta(row.output_per_1m_usd, direct?.output_per_1m_usd ?? null);
              return (
                <div key={`${row.aggregator_id}:${row.provider}:${row.aggregator_model_id}`} className="border-t border-[var(--border)]/40 px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="text-xs text-[var(--text-primary)]">{row.provider} / {row.model_id}</span>
                    <span className="flex flex-wrap gap-x-3 text-[11px] tabular-nums text-[var(--text-secondary)]">
                      <span>Input: {row.input_per_1m_usd == null ? "n/a" : formatMoney(row.input_per_1m_usd, currencyInfo)} / 1M tokens</span>
                      <span>Output: {row.output_per_1m_usd == null ? "n/a" : formatMoney(row.output_per_1m_usd, currencyInfo)} / 1M tokens</span>
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--text-secondary)]">
                    <span>{row.aggregator_name} · {row.route}</span>
                    {inputDelta || outputDelta ? <span>vs direct: input {inputDelta ?? "n/a"}, output {outputDelta ?? "n/a"}</span> : null}
                    {row.has_conditional_pricing ? <span className="text-amber-700 dark:text-amber-300">conditional pricing</span> : null}
                    {!row.ok ? <span className="text-amber-700 dark:text-amber-300">stale</span> : null}
                    <a href={row.source_url} target="_blank" rel="noreferrer" className="ml-auto text-cyan-700 hover:underline dark:text-cyan-300">source ↗</a>
                  </div>
                </div>
              );
            })
          )}
        </div>
        {aggregatorRates.length > 100 ? (
          <p className="px-3 pb-2 text-[10px] text-[var(--text-secondary)]">Showing 100 of {aggregatorRates.length}; narrow the model filter to inspect more.</p>
        ) : null}
      </div>
      <p className="text-[11px] text-[var(--text-secondary)]">{pricing.notes}</p>
    </section>
  );
}

function priceDelta(aggregator: number | null, direct: number | null): string | null {
  if (aggregator == null || direct == null || direct === 0) return null;
  const percent = ((aggregator - direct) / direct) * 100;
  return `${percent > 0 ? "+" : ""}${Math.round(percent)}%`;
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-all text-sm text-[var(--text-primary)]">{row.model_id}</span>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-[var(--text-secondary)]">
          <span>Input: <span className="text-[var(--text-primary)]">{inputLabel}</span> / 1M tokens</span>
          <span>Output: <span className="text-[var(--text-primary)]">{outputLabel}</span> / 1M tokens</span>
        </div>
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
        {row.source === "jarela:known-rates" ? (
          <span
            title="Curated Jarela fallback rate; it may be older than the live vendor pricing snapshot."
            className="ml-auto rounded-full bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-300"
          >
            curated fallback
          </span>
        ) : safeHttpUrl(row.source) ? (
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
