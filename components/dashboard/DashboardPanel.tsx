"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { DashboardCurrencyInfo, DashboardMetrics, UserProfile } from "@/api/types";
import { Activity, BarChart3, Coins, RotateCw, ShieldCheck, TrendingUp } from "lucide-react";
import { withAlpha } from "@/lib/dashboard/color";
import { arcPath } from "@/lib/dashboard/geometry";
import { detectModelFunctionality } from "@/lib/dashboard/classify";
import {
  convertUsd,
  formatInt,
  formatMoney,
  formatMoneyCompact,
  safeHttpUrl,
} from "@/lib/dashboard/format";
import {
  filterModelRates,
  groupModelRatesByVendor,
  sortModelRates,
  sortTools,
  type ModelSort,
  type ToolSort,
} from "@/lib/dashboard/sort";

type WindowDays = 7 | 14 | 30 | 60;
type CurrencyMode = "auto" | "manual";

const WINDOWS: WindowDays[] = [7, 14, 30, 60];
const MANUAL_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CNY", "INR", "BRL", "MXN"] as const;
const TOOL_SORT_OPTIONS = [
  { value: "best", label: "Sort: best first" },
  { value: "calls_desc", label: "Sort: most calls" },
  { value: "errors_desc", label: "Sort: most errors" },
  { value: "error_rate_desc", label: "Sort: highest error rate" },
  { value: "name_asc", label: "Sort: name A->Z" },
] as const;
const MODEL_SORT_OPTIONS = [
  { value: "model_asc", label: "Sort: model A->Z" },
  { value: "model_desc", label: "Sort: model Z->A" },
  { value: "input_desc", label: "Sort: highest input rate" },
  { value: "input_asc", label: "Sort: lowest input rate" },
  { value: "output_desc", label: "Sort: highest output rate" },
  { value: "output_asc", label: "Sort: lowest output rate" },
  { value: "confidence_desc", label: "Sort: confidence" },
  { value: "confidence_asc", label: "Sort: lowest confidence" },
] as const;
const CURRENCY_MODE_KEY = "jarela.dashboard.currency.mode";
const CURRENCY_PICK_KEY = "jarela.dashboard.currency.pick";

const USD_CURRENCY: DashboardCurrencyInfo = {
  currency: "USD",
  rate_from_usd: 1,
  country_code: null,
  source: "default",
  updated_at: "",
};

export function DashboardPanel() {
  const [days, setDays] = useState<WindowDays>(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DashboardMetrics | null>(null);
  const [currencyInfo, setCurrencyInfo] = useState<DashboardCurrencyInfo>(USD_CURRENCY);
  const [currencyMode, setCurrencyMode] = useState<CurrencyMode>("auto");
  const [manualCurrency, setManualCurrency] = useState<string>("USD");
  const [profileLocation, setProfileLocation] = useState<{ lat: number | null; lng: number | null }>({ lat: null, lng: null });
  const [refreshingPricing, setRefreshingPricing] = useState(false);
  const [refreshHint, setRefreshHint] = useState<string | null>(null);
  const [toolSort, setToolSort] = useState<ToolSort>("best");
  const [modelVendorFilter, setModelVendorFilter] = useState<string>("all");
  const [modelFunctionFilter, setModelFunctionFilter] = useState<string>("all");
  const [modelSearch, setModelSearch] = useState<string>("");
  const [modelSort, setModelSort] = useState<ModelSort>("model_asc");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.dashboard.metrics(days)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const onRefreshPricing = async () => {
    setRefreshingPricing(true);
    setRefreshHint(null);
    try {
      const res = await api.dashboard.refreshPricing({ force: true });
      setRefreshHint(res.refreshed ? "Pricing snapshot refreshed." : "Pricing snapshot already fresh.");
      setLoading(true);
      setError(null);
      const metrics = await api.dashboard.metrics(days);
      setData(metrics);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to refresh pricing.";
      setRefreshHint(message);
      setError(message);
    } finally {
      setLoading(false);
      setRefreshingPricing(false);
    }
  };

  useEffect(() => {
    try {
      const savedMode = window.localStorage.getItem(CURRENCY_MODE_KEY);
      if (savedMode === "auto" || savedMode === "manual") setCurrencyMode(savedMode);
      const savedCurrency = window.localStorage.getItem(CURRENCY_PICK_KEY);
      if (savedCurrency && /^[A-Z]{3}$/.test(savedCurrency)) setManualCurrency(savedCurrency);
    } catch {
      /* ignore storage failures */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(CURRENCY_MODE_KEY, currencyMode);
      window.localStorage.setItem(CURRENCY_PICK_KEY, manualCurrency);
    } catch {
      /* ignore storage failures */
    }
  }, [currencyMode, manualCurrency]);

  useEffect(() => {
    let cancelled = false;
    api.profile.get()
      .then((profile: UserProfile) => {
        if (cancelled) return;
        setProfileLocation({
          lat: Number.isFinite(profile.location_lat) ? (profile.location_lat as number) : null,
          lng: Number.isFinite(profile.location_lng) ? (profile.location_lng as number) : null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setProfileLocation({ lat: null, lng: null });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (currencyMode === "manual") {
      api.dashboard.currency({ currency: manualCurrency })
        .then((resolved) => {
          if (!cancelled) setCurrencyInfo(resolved);
        })
        .catch(() => {
          if (!cancelled) setCurrencyInfo(USD_CURRENCY);
        });
      return () => {
        cancelled = true;
      };
    }

    if (!Number.isFinite(profileLocation.lat) || !Number.isFinite(profileLocation.lng)) {
      setCurrencyInfo(USD_CURRENCY);
      return () => {
        cancelled = true;
      };
    }

    api.dashboard.currency({ lat: profileLocation.lat, lng: profileLocation.lng })
      .then((resolved) => {
        if (!cancelled) setCurrencyInfo(resolved);
      })
      .catch(() => {
        if (!cancelled) setCurrencyInfo(USD_CURRENCY);
      });

    return () => {
      cancelled = true;
    };
  }, [currencyMode, manualCurrency, profileLocation.lat, profileLocation.lng]);

  const series = useMemo(() => data?.series ?? [], [data]);
  const dayBreakdown = useMemo(() => {
    if (!data || !selectedDay) return null;
    return data.breakdowns_by_day[selectedDay] ?? null;
  }, [data, selectedDay]);
  // Drop the day selection whenever the underlying window changes, otherwise
  // the breakdown would silently keep showing stale numbers (or nothing) for
  // a day that no longer falls inside the new window.
  useEffect(() => {
    setSelectedDay(null);
  }, [days]);

  // Effective slices: when a day is selected, replace the window-wide
  // top_agents / by_provider / by_model with that day's slices so the
  // pies and lists animate to the new values.
  const effectiveTopAgents = dayBreakdown?.top_agents ?? data?.top_agents ?? [];
  const effectiveByProvider = dayBreakdown?.by_provider ?? data?.by_provider ?? [];
  const effectiveByModel = dayBreakdown?.by_model ?? data?.by_model ?? [];
  const effectiveSummary = dayBreakdown?.summary ?? data?.summary;
  const filteredModelRates = useMemo(() => {
    if (!data) return [];
    const filtered = filterModelRates(data.pricing.model_rates, {
      vendor: modelVendorFilter,
      functionality: modelFunctionFilter,
      search: modelSearch,
    });
    return sortModelRates(filtered, modelSort);
  }, [data, modelVendorFilter, modelFunctionFilter, modelSearch, modelSort]);

  const groupedModelRates = useMemo(
    () => groupModelRatesByVendor(filteredModelRates),
    [filteredModelRates],
  );
  const modelVendors = useMemo(
    () => [...new Set((data?.pricing.model_rates ?? []).map((r) => r.provider))].sort(),
    [data],
  );
  const modelFunctionalities = useMemo(
    () => [...new Set((data?.pricing.model_rates ?? []).map((r) => detectModelFunctionality(r.model_id)))].sort(),
    [data],
  );
  const sortedTools = useMemo(() => {
    if (!data) return [];
    return sortTools(data.top_tools, toolSort);
  }, [data, toolSort]);
  const windowTokenTotal = (data?.summary.input_tokens_est ?? 0) + (data?.summary.output_tokens_est ?? 0);
  const activeDays = series.filter((s) => (s.input_tokens_est + s.output_tokens_est) > 0).length;
  const avgDailyTokens = data ? Math.round(windowTokenTotal / Math.max(data.days, 1)) : 0;
  const avgDailyCostUsd = data ? data.summary.estimated_cost_usd / Math.max(data.days, 1) : 0;

  return (
    <div className="relative h-full overflow-y-auto p-4 md:p-6 space-y-4">
      <div className="mx-auto max-w-7xl space-y-4">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-20 -right-20 w-72 h-72 rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="absolute top-64 -left-24 w-80 h-80 rounded-full bg-emerald-500/10 blur-3xl" />
      </div>

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
                onClick={() => setDays(w)}
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

      {!loading && !error && data ? (
        <div className="relative grid gap-2 md:grid-cols-4">
          <InsightChip
            label="Window tokens"
            value={formatInt(windowTokenTotal)}
            hint={`${formatInt(activeDays)} active day${activeDays === 1 ? "" : "s"} in ${data.days}d`}
          />
          <InsightChip
            label="Avg tokens / day"
            value={formatInt(avgDailyTokens)}
            hint="Heuristic from message length"
          />
          <InsightChip
            label="Window cost"
            value={formatMoney(data.summary.estimated_cost_usd, currencyInfo)}
            hint="Estimated from pricing snapshot"
          />
          <InsightChip
            label="Avg cost / day"
            value={formatMoney(avgDailyCostUsd, currencyInfo)}
            hint="Smoothes short-day spikes"
          />
        </div>
      ) : null}

      <div className="relative flex flex-wrap items-center gap-2 px-1 py-1">
        <span className="text-xs text-[var(--text-secondary)]">Currency</span>
        <div className="inline-flex rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/80 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setCurrencyMode("auto")}
            className={`px-2 py-0.5 rounded transition-colors ${
              currencyMode === "auto"
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            Auto
          </button>
          <button
            type="button"
            onClick={() => setCurrencyMode("manual")}
            className={`px-2 py-0.5 rounded transition-colors ${
              currencyMode === "manual"
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            Manual
          </button>
        </div>
        {currencyMode === "manual" ? (
          <select
            value={manualCurrency}
            onChange={(e) => setManualCurrency(e.target.value)}
            className="rounded-md bg-[var(--bg-primary)]/60 px-2 py-1 text-xs text-[var(--text-primary)]"
          >
            {MANUAL_CURRENCIES.map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </select>
        ) : (
          <span className="text-[11px] text-[var(--text-secondary)]">
            using <span className="text-[var(--text-primary)] font-medium">{currencyInfo.currency}</span>
            {currencyInfo.country_code ? ` (${currencyInfo.country_code})` : ""}
          </span>
        )}
      </div>

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
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <MetricCard label={selectedDay ? `Input tokens on ${selectedDay}` : "Input tokens (est)"} value={formatInt(effectiveSummary?.input_tokens_est ?? 0)} icon={<BarChart3 size={15} />} />
            <MetricCard label={selectedDay ? `Output tokens on ${selectedDay}` : "Output tokens (est)"} value={formatInt(effectiveSummary?.output_tokens_est ?? 0)} icon={<TrendingUp size={15} />} />
            <MetricCard
              label={selectedDay ? `Cost on ${selectedDay} (${currencyInfo.currency})` : `Estimated cost (${currencyInfo.currency})`}
              value={formatMoney(effectiveSummary?.estimated_cost_usd ?? 0, currencyInfo)}
              icon={<Coins size={15} />}
            />
            <MetricCard label="Tool success rate" value={`${((effectiveSummary?.success_rate ?? 1) * 100).toFixed(1)}%`} icon={<ShieldCheck size={15} />} />
            <MetricCard label="Tool error rate" value={`${((effectiveSummary?.error_rate ?? 0) * 100).toFixed(1)}%`} icon={<Activity size={15} />} />
          </div>

          <p className="text-[11px] text-[var(--text-secondary)]">
            {currencyInfo.source === "manual"
              ? `Currency manually set to ${currencyInfo.currency}.`
              : currencyInfo.source === "location"
              ? `Currency converted from USD to ${currencyInfo.currency} based on saved location.`
              : "Currency defaults to USD because no location-based currency is available."}
          </p>

          <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-4 shadow-sm">
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">Token usage over time</h3>
            <InteractiveTokenChart
              series={series}
              selectedDay={selectedDay}
              onSelectDay={(day) => setSelectedDay((prev) => (prev === day ? null : day))}
            />
          </section>

          <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-4 shadow-sm">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-[var(--text-primary)]">Estimated cost over time</h3>
              {selectedDay ? (
                <button
                  type="button"
                  onClick={() => setSelectedDay(null)}
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
            <InteractiveCostChart
              series={series}
              currencyInfo={currencyInfo}
              selectedDay={selectedDay}
              onSelectDay={(day) => setSelectedDay((prev) => (prev === day ? null : day))}
            />
          </section>

          <div className="grid md:grid-cols-2 gap-4">
            <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-4 shadow-sm">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-[var(--text-primary)]">Favorite tools</h3>
                <select
                  value={toolSort}
                  onChange={(e) => setToolSort(e.target.value as typeof toolSort)}
                  className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]"
                  style={{ color: "var(--text-primary)", backgroundColor: "var(--bg-primary)" }}
                >
                  {TOOL_SORT_OPTIONS.map((opt) => (
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
              <div className="space-y-2">
                {sortedTools.length === 0 ? (
                  <p className="text-xs text-[var(--text-secondary)]">No tool calls recorded yet.</p>
                ) : (
                  sortedTools.map((tool) => (
                    <div key={tool.name} className="rounded-lg bg-[var(--bg-primary)]/35 px-3 py-2">
                      <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm text-[var(--text-primary)]">{tool.name}</div>
                          <div className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
                            score {tool.score.toFixed(2)} · {(tool.success_rate * 100).toFixed(1)}% success · {tool.call_count} calls · {tool.error_count} errors
                          </div>
                        </div>
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          tool.score >= 0.85
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            : tool.score >= 0.65
                            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                            : "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                        }`}>
                          {tool.score >= 0.85 ? "keep" : tool.score >= 0.65 ? "review" : "consider disable"}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-4 shadow-sm">
              <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">
                Agent cost hotspots
                {selectedDay ? <span className="ml-2 text-[11px] text-[var(--text-secondary)]">on {selectedDay}</span> : null}
              </h3>
              <AgentCostPie
                key={`agents-${selectedDay ?? "all"}`}
                agents={effectiveTopAgents.slice(0, 6)}
                currencyInfo={currencyInfo}
              />
            </section>
          </div>

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
                    onChange={(e) => setModelVendorFilter(e.target.value)}
                    className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]"
                    style={{ color: "var(--text-primary)", backgroundColor: "var(--bg-primary)" }}
                  >
                    <option value="all" style={{ color: "var(--text-primary)", backgroundColor: "var(--bg-secondary)" }}>All vendors</option>
                    {modelVendors.map((provider) => (
                      <option key={provider} value={provider} style={{ color: "var(--text-primary)", backgroundColor: "var(--bg-secondary)" }}>
                        {provider}
                      </option>
                    ))}
                  </select>
                  <select
                    value={modelFunctionFilter}
                    onChange={(e) => setModelFunctionFilter(e.target.value)}
                    className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]"
                    style={{ color: "var(--text-primary)", backgroundColor: "var(--bg-primary)" }}
                  >
                    <option value="all" style={{ color: "var(--text-primary)", backgroundColor: "var(--bg-secondary)" }}>All functions</option>
                    {modelFunctionalities.map((func) => (
                      <option key={func} value={func} style={{ color: "var(--text-primary)", backgroundColor: "var(--bg-secondary)" }}>
                        {func}
                      </option>
                    ))}
                  </select>
                  <input
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder="Filter models (e.g. gpt, gemini, deepseek)"
                    className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]"
                  />
                  <select
                    value={modelSort}
                    onChange={(e) => setModelSort(e.target.value as typeof modelSort)}
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
                {filteredModelRates.length === 0 ? (
                  <p className="p-3 text-xs text-[var(--text-secondary)]">No model rates match the selected filters.</p>
                ) : (
                  groupedModelRates.map(([provider, rows]) => (
                    <div key={provider} className="border-b border-[var(--border)]/60 last:border-b-0">
                      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-l-2 border-l-[var(--accent)] bg-[var(--bg-secondary)]/95 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-primary)] backdrop-blur">
                        <span>{provider}</span>
                        <span className="rounded-full border border-[var(--border)] bg-[var(--bg-primary)]/60 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-[var(--text-secondary)]">
                          {rows.length} model{rows.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      {rows.map((row) => (
                        <div key={`${row.provider}:${row.model_id}`} className="px-3 py-2 border-t border-[var(--border)]/40 hover:bg-[var(--bg-primary)]/35 transition-colors">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm text-[var(--text-primary)] truncate">{row.model_id}</span>
                            <span className="text-[11px] tabular-nums text-[var(--text-secondary)]">
                              in <span className="text-[var(--text-primary)]">${row.input_per_1m_usd?.toFixed(2) ?? "n/a"}</span>
                              {" · "}out <span className="text-[var(--text-primary)]">${row.output_per_1m_usd?.toFixed(2) ?? "n/a"}</span>
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
                      ))}
                    </div>
                  ))
                )}
              </div>
            </div>
            <p className="text-[11px] text-[var(--text-secondary)]">{data.pricing.notes}</p>
          </section>
        </>
      )}
      </div>
    </div>
  );
}

function MetricCard({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-[var(--bg-secondary)]/70 px-3 py-3">
      <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)] inline-flex items-center gap-1.5">
        {icon ? <span className="text-[var(--text-secondary)]">{icon}</span> : null}
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold text-[var(--text-primary)] leading-tight">{value}</p>
    </div>
  );
}

function InsightChip({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl bg-[var(--bg-secondary)]/55 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)]">{label}</div>
      <div className="mt-1 text-base font-semibold text-[var(--text-primary)]">{value}</div>
      <div className="mt-0.5 text-[11px] text-[var(--text-secondary)]">{hint}</div>
    </div>
  );
}

// Per-tier breakdown colors shared by the stacked token chart legend.
const TIER_COLORS: Record<"hot" | "warm" | "facts" | "overhead", string> = {
  hot: "#22d3ee",
  warm: "#f59e0b",
  facts: "#a78bfa",
  overhead: "#94a3b8",
};

type DonutSlice = {
  id: string;
  label: string;
  value: number;
  color: string;
};

function SharedDonutChart({
  ariaLabel,
  size,
  centerAmount,
  slices,
  hovered,
  onHoverChange,
}: {
  ariaLabel: string;
  size: number;
  centerAmount: string;
  slices: DonutSlice[];
  hovered: number | null;
  onHoverChange: (index: number | null) => void;
}) {
  const uid = useId().replace(/:/g, "");
  const [animCycle, setAnimCycle] = useState(0);
  const stroke = size >= 170 ? 26 : 20;
  const padding = Math.ceil(stroke / 2) + 6;
  const cx = size / 2;
  const cy = size / 2;
  const radius = Math.max(16, (size - (padding * 2) - stroke) / 2);
  const innerRadius = Math.max(14, radius - (stroke / 2) + 2);
  const gap = 0.03;
  const total = slices.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const animationSignature = slices.map((slice) => `${slice.id}:${slice.value.toFixed(6)}`).join("|");

  useEffect(() => {
    setAnimCycle((v) => v + 1);
  }, [animationSignature]);

  const segments = slices.map((slice, idx) => {
    const value = Math.max(0, slice.value);
    const fraction = total > 0 ? value / total : 1 / Math.max(1, slices.length);
    const startAngle = -Math.PI / 2 + slices
      .slice(0, idx)
      .reduce((sum, s) => sum + (total > 0 ? Math.max(0, s.value) / total : 1 / Math.max(1, slices.length)), 0) * Math.PI * 2;
    const sweep = fraction * Math.PI * 2;
    const gapSafe = Math.min(gap, sweep * 0.45);
    const arcStart = startAngle + (gapSafe / 2);
    const arcEnd = startAngle + sweep - (gapSafe / 2);
    return {
      ...slice,
      idx,
      fraction,
      path: arcPath(cx, cy, radius, arcStart, arcEnd),
    };
  });

  const active = hovered != null ? segments[hovered] : null;
  const glowColor = active?.color ?? "#22c55e";

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: `${size}px`, height: `${size}px` }}>
        <div
          className="pointer-events-none absolute inset-4 rounded-full blur-2xl"
          style={{
            background: `radial-gradient(circle, ${withAlpha(glowColor, 0.28)} 0%, transparent 72%)`,
            opacity: active ? 0.85 : 0.55,
            transition: "opacity 180ms ease",
          }}
        />

        <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full" role="img" aria-label={ariaLabel}>
          <defs>
            <radialGradient id={`${uid}-center`} cx="50%" cy="38%" r="70%">
              <stop offset="0%" stopColor="var(--bg-secondary)" stopOpacity="0.98" />
              <stop offset="100%" stopColor="var(--bg-primary)" stopOpacity="0.92" />
            </radialGradient>
          </defs>

          <circle cx={cx} cy={cy} r={radius} fill="none" stroke="rgba(148,163,184,0.18)" strokeWidth={stroke} />

          {segments.map((segment) => (
            <g key={segment.id}>
              <path
                key={`${segment.id}-${animCycle}`}
                d={segment.path}
                fill="none"
                stroke={segment.color}
                strokeLinecap="butt"
                strokeLinejoin="round"
                strokeWidth={hovered === segment.idx ? stroke + 2 : stroke}
                pathLength={100}
                strokeDasharray={100}
                strokeDashoffset={100}
                opacity={hovered == null || hovered === segment.idx ? 0.97 : 0.54}
                style={{ transition: "opacity 180ms ease, stroke-width 180ms ease" }}
                onMouseEnter={() => onHoverChange(segment.idx)}
                onMouseLeave={() => onHoverChange(null)}
              >
                <animate
                  attributeName="stroke-dashoffset"
                  from="100"
                  to="0"
                  dur="620ms"
                  begin={`${segment.idx * 65}ms`}
                  fill="freeze"
                />
              </path>
            </g>
          ))}

          <circle cx={cx} cy={cy} r={innerRadius} fill={`url(#${uid}-center)`} stroke="var(--border)" strokeWidth="1" />
        </svg>

        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center">
          <div className="max-w-[70%]">
            <div className={`${size >= 170 ? "text-sm" : "text-xs"} font-semibold leading-tight text-[var(--text-primary)] truncate`}>
              {centerAmount}
            </div>
          </div>
        </div>
      </div>

      <div
        className={`mt-2 inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[10px] tracking-wide transition-opacity ${
          active
            ? "bg-[var(--bg-primary)]/60 text-[var(--text-primary)] opacity-100"
            : "bg-transparent text-[var(--text-secondary)] opacity-60"
        }`}
      >
        {active ? (
          <>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: active.color }} />
            <span className="max-w-[160px] truncate">{active.label}</span>
            <span className="font-medium">{(active.fraction * 100).toFixed(1)}%</span>
          </>
        ) : (
          <span>hover a segment</span>
        )}
      </div>
    </div>
  );
}

function AgentCostPie({
  agents,
  currencyInfo,
}: {
  agents: DashboardMetrics["top_agents"];
  currencyInfo: DashboardCurrencyInfo;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  if (agents.length === 0) {
    return <p className="text-xs text-[var(--text-secondary)]">No recent traffic yet.</p>;
  }

  const colors = [
    "#22c55e",
    "#06b6d4",
    "#3b82f6",
    "#8b5cf6",
    "#f59e0b",
    "#ef4444",
  ];

  const total = agents.reduce((sum, a) => sum + Math.max(0, a.estimated_cost_usd), 0);
  const fractions = agents.map((agent) => {
    const value = Math.max(0, agent.estimated_cost_usd);
    return total > 0 ? value / total : 1 / agents.length;
  });

  const slices = agents.map((agent, idx) => {
    const value = Math.max(0, agent.estimated_cost_usd);
    const fraction = fractions[idx];
    return {
      idx,
      agent,
      value,
      fraction,
      color: colors[idx % colors.length],
    };
  });

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[190px_1fr]">
      <SharedDonutChart
        ariaLabel="Agent cost share pie chart"
        size={190}
        centerAmount={formatMoneyCompact(total, currencyInfo)}
        hovered={hovered}
        onHoverChange={setHovered}
        slices={slices.map((slice) => ({
          id: slice.agent.agent_id,
          label: slice.agent.agent_name,
          value: slice.value,
          color: slice.color,
        }))}
      />

      <div className="space-y-2">
        {slices.map((slice) => (
          <div
            key={slice.agent.agent_id}
            onMouseEnter={() => setHovered(slice.idx)}
            onMouseLeave={() => setHovered(null)}
            className={`rounded-lg border px-3 py-2 transition-colors ${
              hovered === slice.idx
                ? "border-[var(--accent)]/50 bg-[var(--bg-primary)]/70"
                : "border-[var(--border)] bg-[var(--bg-primary)]/45"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex min-w-0 items-center gap-2 text-sm text-[var(--text-primary)]">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: slice.color }} />
                <span className="truncate">{slice.agent.agent_name}</span>
              </span>
              <span className="text-xs text-[var(--text-secondary)]">{formatMoney(slice.value, currencyInfo)}</span>
            </div>
            <div className="mt-1 text-xs text-[var(--text-secondary)]">
              {(slice.fraction * 100).toFixed(1)}% · {formatInt(slice.agent.message_count)} msgs · {formatInt(slice.agent.input_tokens_est + slice.agent.output_tokens_est)} tokens
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BreakdownPiePanel({
  title,
  items,
  currencyInfo,
  emptyLabel,
}: {
  title: string;
  items: Array<{ id: string; label: string; cost: number; detail: string }>;
  currencyInfo: DashboardCurrencyInfo;
  emptyLabel: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const palette = ["#14b8a6", "#22c55e", "#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444", "#06b6d4", "#84cc16"];

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)]/35 p-3">
        <div className="text-xs font-medium text-[var(--text-primary)]">{title}</div>
        <p className="mt-2 text-xs text-[var(--text-secondary)]">{emptyLabel}</p>
      </div>
    );
  }

  const total = items.reduce((sum, item) => sum + Math.max(0, item.cost), 0);
  const fractions = items.map((item) => {
    const value = Math.max(0, item.cost);
    return total > 0 ? value / total : 1 / items.length;
  });

  const slices = items.map((item, idx) => {
    const value = Math.max(0, item.cost);
    const fraction = fractions[idx];
    return {
      ...item,
      idx,
      value,
      fraction,
      color: palette[idx % palette.length],
    };
  });

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)]/35 p-3">
      <div className="mb-2 text-xs font-medium text-[var(--text-primary)]">{title}</div>
      <div className="grid grid-cols-[136px_1fr] gap-3">
        <SharedDonutChart
          ariaLabel={`${title} pie chart`}
          size={136}
          centerAmount={formatMoneyCompact(total, currencyInfo)}
          hovered={hovered}
          onHoverChange={setHovered}
          slices={slices.map((slice) => ({
            id: slice.id,
            label: slice.label,
            value: slice.value,
            color: slice.color,
          }))}
        />

        <div className="max-h-56 space-y-1.5 overflow-auto pr-1">
          {slices.map((slice) => (
            <div
              key={slice.id}
              onMouseEnter={() => setHovered(slice.idx)}
              onMouseLeave={() => setHovered(null)}
              className={`rounded-md px-2.5 py-2 ${
                hovered === slice.idx
                  ? "bg-[var(--bg-primary)]/70"
                  : "bg-[var(--bg-primary)]/35"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-[var(--text-primary)]">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: slice.color }} />
                  <span className="truncate">{slice.label}</span>
                </span>
                <span className="text-[11px] text-[var(--text-secondary)]">{formatMoney(slice.value, currencyInfo)}</span>
              </div>
              <div className="mt-0.5 text-[10px] text-[var(--text-secondary)] truncate">
                {(slice.fraction * 100).toFixed(1)}% · {slice.detail}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function InteractiveTokenChart({
  series,
  selectedDay,
  onSelectDay,
}: {
  series: DashboardMetrics["series"];
  selectedDay?: string | null;
  onSelectDay?: (day: string) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [barsReady, setBarsReady] = useState(false);
  const maxTotal = series.reduce((max, p) => Math.max(max, p.input_tokens_est + p.output_tokens_est), 0);
  const active = hovered != null ? series[hovered] : null;
  const animationSignature = series.map((s) => `${s.day}:${s.input_tokens_est}:${s.output_tokens_est}`).join("|");

  useEffect(() => {
    setBarsReady(false);
    const frame = requestAnimationFrame(() => setBarsReady(true));
    return () => cancelAnimationFrame(frame);
  }, [animationSignature]);

  if (series.length === 0) {
    return <p className="text-xs text-[var(--text-secondary)]">No token data yet.</p>;
  }

  return (
    <div>
      <div className="relative h-48 rounded-xl bg-[var(--bg-primary)]/35 p-2">
        <div
          className={`absolute right-2 top-2 inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[10px] tracking-wide transition-opacity ${
            active
              ? "bg-[var(--bg-secondary)]/85 text-[var(--text-primary)] opacity-100"
              : "text-[var(--text-secondary)] opacity-60"
          }`}
        >
          {active
            ? `${active.day} · ${formatInt(active.input_tokens_est + active.output_tokens_est)} tokens`
            : "hover bars for details"}
        </div>
        <div className="h-full flex items-end gap-1 pt-5">
          {series.map((point, idx) => {
            const total = point.input_tokens_est + point.output_tokens_est;
            const hasData = total > 0;
            const totalHeight = hasData && maxTotal > 0 ? Math.max(4, Math.round((total / maxTotal) * 150)) : 0;
            const inputHeight = hasData ? Math.round((point.input_tokens_est / total) * totalHeight) : 0;
            const outputHeight = hasData ? Math.max(0, totalHeight - inputHeight) : 0;
            // Subdivide the input portion by measured tier breakdown when the
            // day has at least one snapshotted assistant turn. Legacy days
            // (measured_input_tokens === 0) fall back to a solid violet block.
            const tier = point.tier_tokens;
            const tierTotal = tier?.measured_input_tokens ?? 0;
            const hotPx = tierTotal > 0 ? Math.round((tier.hot_tokens / tierTotal) * inputHeight) : 0;
            const warmPx = tierTotal > 0 ? Math.round((tier.warm_tokens / tierTotal) * inputHeight) : 0;
            const factsPx = tierTotal > 0 ? Math.round((tier.facts_tokens / tierTotal) * inputHeight) : 0;
            const overheadPx = tierTotal > 0 ? Math.max(0, inputHeight - hotPx - warmPx - factsPx) : 0;
            const isActive = idx === hovered;
            const isSelected = selectedDay === point.day;
            const clickable = !!onSelectDay && hasData;
            return (
              <div
                key={point.day}
                onMouseEnter={() => setHovered(idx)}
                onMouseLeave={() => setHovered(null)}
                onClick={clickable ? () => onSelectDay!(point.day) : undefined}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={clickable ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectDay!(point.day);
                  }
                } : undefined}
                className={`flex-1 min-w-0 h-full flex flex-col items-center justify-end ${clickable ? "cursor-pointer" : ""}`}
                aria-label={`${point.day} tokens${clickable ? " — click to filter" : " (informational)"}`}
                aria-pressed={clickable ? isSelected : undefined}
              >
                <div className={`w-full rounded-t overflow-hidden border transition-colors ${
                  isSelected
                    ? "border-[var(--accent)]/70 shadow-[0_0_0_1px_var(--accent)]"
                    : isActive
                    ? "border-cyan-300/60 shadow-[0_0_0_1px_rgba(34,211,238,0.35)]"
                    : "border-transparent"
                }`}>
                  {hasData ? (
                    <>
                      <div
                        className="w-full bg-gradient-to-t from-amber-500 to-amber-300"
                        style={{
                          height: barsReady ? `${outputHeight}px` : "0px",
                          transition: `height 420ms cubic-bezier(0.2, 0.8, 0.2, 1) ${idx * 18}ms`,
                        }}
                      />
                      {tierTotal > 0 ? (
                        <>
                          <div
                            className="w-full"
                            style={{
                              background: TIER_COLORS.hot,
                              height: barsReady ? `${hotPx}px` : "0px",
                              transition: `height 420ms cubic-bezier(0.2, 0.8, 0.2, 1) ${idx * 18 + 30}ms`,
                            }}
                          />
                          <div
                            className="w-full"
                            style={{
                              background: TIER_COLORS.warm,
                              height: barsReady ? `${warmPx}px` : "0px",
                              transition: `height 420ms cubic-bezier(0.2, 0.8, 0.2, 1) ${idx * 18 + 42}ms`,
                            }}
                          />
                          <div
                            className="w-full"
                            style={{
                              background: TIER_COLORS.facts,
                              height: barsReady ? `${factsPx}px` : "0px",
                              transition: `height 420ms cubic-bezier(0.2, 0.8, 0.2, 1) ${idx * 18 + 54}ms`,
                            }}
                          />
                          <div
                            className="w-full"
                            style={{
                              background: TIER_COLORS.overhead,
                              height: barsReady ? `${overheadPx}px` : "0px",
                              transition: `height 420ms cubic-bezier(0.2, 0.8, 0.2, 1) ${idx * 18 + 66}ms`,
                            }}
                          />
                        </>
                      ) : (
                        <div
                          className="w-full bg-gradient-to-t from-indigo-500 to-violet-400"
                          style={{
                            height: barsReady ? `${inputHeight}px` : "0px",
                            transition: `height 420ms cubic-bezier(0.2, 0.8, 0.2, 1) ${idx * 18 + 30}ms`,
                          }}
                        />
                      )}
                    </>
                  ) : null}
                </div>
                <span className={`mt-1 text-[10px] truncate w-full text-center ${hasData ? "text-[var(--text-secondary)]" : "text-[var(--text-secondary)]/50"}`}>
                  {point.day.slice(5)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-[var(--text-secondary)]">
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: TIER_COLORS.hot }} />hot</span>
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: TIER_COLORS.warm }} />warm</span>
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: TIER_COLORS.facts }} />facts</span>
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: TIER_COLORS.overhead }} />overhead</span>
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-violet-400" />input (est)</span>
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400" />output</span>
        {active && (
          <span className="ml-auto text-[var(--text-primary)]">
            {active.tier_tokens.measured_input_tokens > 0
              ? `hot ${formatInt(active.tier_tokens.hot_tokens)} · warm ${formatInt(active.tier_tokens.warm_tokens)} · facts ${formatInt(active.tier_tokens.facts_tokens)} · overhead ${formatInt(active.tier_tokens.overhead_tokens)} · out ${formatInt(active.output_tokens_est)}`
              : `in ${formatInt(active.input_tokens_est)} · out ${formatInt(active.output_tokens_est)}`}
          </span>
        )}
      </div>
    </div>
  );
}

function InteractiveCostChart({
  series,
  currencyInfo,
  selectedDay,
  onSelectDay,
}: {
  series: DashboardMetrics["series"];
  currencyInfo: DashboardCurrencyInfo;
  selectedDay?: string | null;
  onSelectDay?: (day: string) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [lineAnimCycle, setLineAnimCycle] = useState(0);
  const width = 720;
  const height = 180;
  const padX = 24;
  const padY = 22;
  const maxCost = Math.max(0.000001, ...series.map((s) => convertUsd(s.estimated_cost_usd, currencyInfo)));

  const points = series.map((p, idx) => {
    const x = series.length <= 1
      ? width / 2
      : padX + (idx / (series.length - 1)) * (width - (padX * 2));
    const converted = convertUsd(p.estimated_cost_usd, currencyInfo);
    const y = height - padY - ((converted / maxCost) * (height - (padY * 2)));
    return { x, y, p, idx };
  });

  const polyline = points.map((pt) => `${pt.x},${pt.y}`).join(" ");
  const active = hovered != null ? points[hovered] : null;
  const selectedIdx = selectedDay ? points.findIndex((pt) => pt.p.day === selectedDay) : -1;
  const selected = selectedIdx >= 0 ? points[selectedIdx] : null;
  const animationSignature = series.map((s) => `${s.day}:${s.estimated_cost_usd}`).join("|");

  useEffect(() => {
    setLineAnimCycle((v) => v + 1);
  }, [animationSignature, selectedDay]);

  if (series.length === 0) {
    return <p className="text-xs text-[var(--text-secondary)]">No cost data yet.</p>;
  }

  return (
    <div>
      <div className="relative rounded-xl bg-[var(--bg-primary)]/35 p-2">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-48" role="img" aria-label="Estimated cost over time">
          {[0.25, 0.5, 0.75].map((frac) => {
            const y = padY + (1 - frac) * (height - padY * 2);
            return (
              <line
                key={frac}
                x1={padX}
                y1={y}
                x2={width - padX}
                y2={y}
                stroke="rgba(148,163,184,0.12)"
                strokeWidth="1"
                strokeDasharray="3 4"
              />
            );
          })}
          {[0.25, 0.5, 0.75, 1].map((frac) => {
            const y = padY + (1 - frac) * (height - padY * 2);
            const value = maxCost * frac;
            return (
              <text
                key={`tick-${frac}`}
                x={padX - 4}
                y={y + 3}
                textAnchor="end"
                fill="currentColor"
                className="fill-[var(--text-secondary)] text-[8px]"
              >
                {formatMoneyCompact(value / (currencyInfo.rate_from_usd || 1), currencyInfo)}
              </text>
            );
          })}
          <line x1={padX} y1={height - padY} x2={width - padX} y2={height - padY} stroke="rgba(148,163,184,0.45)" strokeWidth="1" />
          <line x1={padX} y1={padY} x2={padX} y2={height - padY} stroke="rgba(148,163,184,0.25)" strokeWidth="1" />
          <polyline
            key={`cost-line-${lineAnimCycle}`}
            fill="none"
            stroke="rgba(16,185,129,0.95)"
            strokeWidth="2.6"
            points={polyline}
            pathLength={100}
            strokeDasharray={100}
            strokeDashoffset={100}
          >
            <animate attributeName="stroke-dashoffset" from="100" to="0" dur="700ms" fill="freeze" />
          </polyline>
          {points.map((pt) => {
            const isActive = pt.idx === hovered;
            const isSelected = pt.idx === selectedIdx;
            return (
              <g key={pt.p.day}>
                {(isActive || isSelected) && (
                  <line
                    x1={pt.x}
                    y1={padY}
                    x2={pt.x}
                    y2={height - padY}
                    stroke={isSelected ? "rgba(34,197,94,0.55)" : "rgba(20,184,166,0.35)"}
                    strokeWidth={isSelected ? 1.8 : 1.5}
                  />
                )}
                {isSelected && (
                  <circle
                    cx={pt.x}
                    cy={pt.y}
                    r={8}
                    fill="none"
                    stroke="rgba(34,197,94,0.85)"
                    strokeWidth={1.5}
                  >
                    <animate attributeName="r" from="3.8" to="9" dur="800ms" repeatCount="indefinite" />
                    <animate attributeName="opacity" from="0.9" to="0" dur="800ms" repeatCount="indefinite" />
                  </circle>
                )}
                <circle
                  key={`${pt.p.day}-${lineAnimCycle}`}
                  cx={pt.x}
                  cy={pt.y}
                  r={isSelected ? 5 : 3.8}
                  fill={isSelected
                    ? "rgba(34,197,94,1)"
                    : isActive
                      ? "rgba(16,185,129,1)"
                      : "rgba(52,211,153,0.85)"}
                  className={onSelectDay ? "cursor-pointer" : undefined}
                  onMouseEnter={() => setHovered(pt.idx)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => onSelectDay?.(pt.p.day)}
                >
                  <animate attributeName="r" from="0" to={isSelected ? 5 : 3.8} dur="260ms" begin={`${pt.idx * 28}ms`} fill="freeze" />
                </circle>
              </g>
            );
          })}
        </svg>
        <div
          className={`absolute right-3 top-3 inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[10px] tracking-wide transition-opacity ${
            active || selected
              ? "bg-[var(--bg-secondary)]/85 text-[var(--text-primary)] opacity-100"
              : "text-[var(--text-secondary)] opacity-60"
          }`}
        >
          {active
            ? `${active.p.day} · ${formatMoney(active.p.estimated_cost_usd, currencyInfo)}`
            : selected
              ? `selected ${selected.p.day} · ${formatMoney(selected.p.estimated_cost_usd, currencyInfo)}`
              : "click a day to narrow breakdown"}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-[11px] text-[var(--text-secondary)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-400" />daily cost
        </span>
        <span className="tabular-nums text-[var(--text-primary)]">
          window total {formatMoney(series.reduce((sum, s) => sum + s.estimated_cost_usd, 0), currencyInfo)}
        </span>
      </div>
    </div>
  );
}


