"use client";

import { useEffect, useMemo, useState } from "react";
import type { ModelSort, ToolSort } from "@/lib/dashboard/sort";
import { CurrencyPickerRow } from "./CurrencyPickerRow";
import { DashboardHeader } from "./DashboardHeader";
import { MetricCardsGrid, SummaryStrip } from "./SummaryCards";
import { TokensCostSection } from "./TokensCostSection";
import { ToolsAndAgentsRow } from "./ToolsAndAgentsRow";
import { VendorModelReportSection } from "./VendorModelReportSection";
import { ModelPricingSection } from "./ModelPricingSection";
import { useCurrencyPreference } from "./useCurrencyPreference";
import { useDashboardData } from "./useDashboardData";

export function DashboardPanel() {
  const {
    days, setDays, loading, error, data,
    refreshingPricing, refreshHint, onRefreshPricing,
  } = useDashboardData(30);
  const {
    currencyInfo, currencyMode, setCurrencyMode,
    manualCurrency, setManualCurrency,
  } = useCurrencyPreference();
  const [toolSort, setToolSort] = useState<ToolSort>("best");
  const [modelVendorFilter, setModelVendorFilter] = useState<string>("all");
  const [modelFunctionFilter, setModelFunctionFilter] = useState<string>("all");
  const [modelSearch, setModelSearch] = useState<string>("");
  const [modelSort, setModelSort] = useState<ModelSort>("model_asc");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // Drop the day selection whenever the window changes; otherwise the
  // breakdown would silently show stale numbers for a day no longer in range.
  useEffect(() => { setSelectedDay(null); }, [days]);

  const series = useMemo(() => data?.series ?? [], [data]);
  const dayBreakdown = useMemo(() => {
    if (!data || !selectedDay) return null;
    return data.breakdowns_by_day[selectedDay] ?? null;
  }, [data, selectedDay]);

  const effectiveTopAgents = dayBreakdown?.top_agents ?? data?.top_agents ?? [];
  const effectiveByProvider = dayBreakdown?.by_provider ?? data?.by_provider ?? [];
  const effectiveByModel = dayBreakdown?.by_model ?? data?.by_model ?? [];
  const effectiveSummary = dayBreakdown?.summary ?? data?.summary;

  const windowTokenTotal = (data?.summary.input_tokens_est ?? 0) + (data?.summary.output_tokens_est ?? 0);
  const activeDays = series.filter((s) => (s.input_tokens_est + s.output_tokens_est) > 0).length;
  const avgDailyTokens = data ? Math.round(windowTokenTotal / Math.max(data.days, 1)) : 0;
  const avgDailyCostUsd = data ? data.summary.estimated_cost_usd / Math.max(data.days, 1) : 0;

  const toggleDay = (day: string) => setSelectedDay((prev) => (prev === day ? null : day));

  return (
    <div className="panel-scrollbar relative h-full overflow-y-auto p-4 md:p-6 space-y-4">
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -top-20 -right-20 w-72 h-72 rounded-full bg-cyan-500/10 blur-3xl" />
          <div className="absolute top-64 -left-24 w-80 h-80 rounded-full bg-emerald-500/10 blur-3xl" />
        </div>

        <DashboardHeader
          days={days}
          onDaysChange={setDays}
          refreshingPricing={refreshingPricing}
          refreshHint={refreshHint}
          onRefreshPricing={onRefreshPricing}
        />

        {!loading && !error && data ? (
          <SummaryStrip
            data={data}
            currencyInfo={currencyInfo}
            windowTokenTotal={windowTokenTotal}
            activeDays={activeDays}
            avgDailyTokens={avgDailyTokens}
            avgDailyCostUsd={avgDailyCostUsd}
          />
        ) : null}

        <CurrencyPickerRow
          currencyMode={currencyMode}
          onModeChange={setCurrencyMode}
          manualCurrency={manualCurrency}
          onManualChange={setManualCurrency}
          currencyInfo={currencyInfo}
        />

        {loading && (
          <div className="relative rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-4 text-sm text-[var(--text-secondary)] shadow-sm">
            Loading dashboard metrics...
          </div>
        )}

        {!loading && error && (
          <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 p-4 text-sm text-rose-200">
            Failed to load dashboard metrics: {error}
          </div>
        )}

        {!loading && !error && data && (
          <>
            <MetricCardsGrid
              effectiveSummary={effectiveSummary}
              currencyInfo={currencyInfo}
              selectedDay={selectedDay}
            />

            <p className="text-[11px] text-[var(--text-secondary)]">
              {currencyInfo.source === "manual"
                ? `Currency manually set to ${currencyInfo.currency}.`
                : currencyInfo.source === "location"
                ? `Currency converted from USD to ${currencyInfo.currency} based on saved location.`
                : "Currency defaults to USD because no location-based currency is available."}
            </p>

            <TokensCostSection
              series={series}
              currencyInfo={currencyInfo}
              selectedDay={selectedDay}
              onToggleDay={toggleDay}
              onClearDay={() => setSelectedDay(null)}
            />

            <ToolsAndAgentsRow
              data={data}
              toolSort={toolSort}
              onToolSortChange={setToolSort}
              effectiveTopAgents={effectiveTopAgents}
              selectedDay={selectedDay}
              currencyInfo={currencyInfo}
            />

            <VendorModelReportSection
              effectiveByProvider={effectiveByProvider}
              effectiveByModel={effectiveByModel}
              selectedDay={selectedDay}
              currencyInfo={currencyInfo}
            />

            <ModelPricingSection
              data={data}
              modelVendorFilter={modelVendorFilter}
              onVendorFilterChange={setModelVendorFilter}
              modelFunctionFilter={modelFunctionFilter}
              onFunctionFilterChange={setModelFunctionFilter}
              modelSearch={modelSearch}
              onSearchChange={setModelSearch}
              modelSort={modelSort}
              onSortChange={setModelSort}
              currencyInfo={currencyInfo}
            />
          </>
        )}
      </div>
    </div>
  );
}
