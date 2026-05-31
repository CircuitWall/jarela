"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { DashboardCurrencyInfo, DashboardMetrics, UserProfile } from "@/api/types";
import { Activity, BarChart3, Coins, RotateCw, ShieldCheck, TrendingUp } from "lucide-react";

type WindowDays = 7 | 14 | 30 | 60;
type CurrencyMode = "auto" | "manual";

const WINDOWS: WindowDays[] = [7, 14, 30, 60];
const MANUAL_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CNY", "INR", "BRL", "MXN"] as const;
const MODEL_SORT_OPTIONS = [
  { value: "model_asc", label: "Sort: model A->Z" },
  { value: "input_desc", label: "Sort: highest input rate" },
  { value: "output_desc", label: "Sort: highest output rate" },
  { value: "confidence_desc", label: "Sort: confidence" },
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
  const [toolSort, setToolSort] = useState<"best" | "calls_desc" | "errors_desc" | "error_rate_desc" | "name_asc">("best");
  const [modelVendorFilter, setModelVendorFilter] = useState<string>("all");
  const [modelSearch, setModelSearch] = useState<string>("");
  const [modelSort, setModelSort] = useState<"model_asc" | "input_desc" | "output_desc" | "confidence_desc">("model_asc");

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
  const filteredModelRates = useMemo(() => {
    if (!data) return [];
    const query = modelSearch.trim().toLowerCase();
    const rows = data.pricing.model_rates.filter((row) => {
      if (modelVendorFilter !== "all" && row.provider !== modelVendorFilter) return false;
      if (!query) return true;
      return `${row.provider}/${row.model_id}`.toLowerCase().includes(query);
    });

    const confidenceRank = (c: "high" | "medium" | "low") => (c === "high" ? 3 : c === "medium" ? 2 : 1);
    rows.sort((a, b) => {
      if (modelSort === "input_desc") {
        return (b.input_per_1m_usd ?? -1) - (a.input_per_1m_usd ?? -1);
      }
      if (modelSort === "output_desc") {
        return (b.output_per_1m_usd ?? -1) - (a.output_per_1m_usd ?? -1);
      }
      if (modelSort === "confidence_desc") {
        const rankDiff = confidenceRank(b.confidence) - confidenceRank(a.confidence);
        if (rankDiff !== 0) return rankDiff;
      }
      return a.model_id.localeCompare(b.model_id);
    });

    return rows;
  }, [data, modelVendorFilter, modelSearch, modelSort]);

  const groupedModelRates = useMemo(() => {
    const grouped = new Map<string, DashboardMetrics["pricing"]["model_rates"]>();
    for (const row of filteredModelRates) {
      const arr = grouped.get(row.provider) ?? [];
      arr.push(row);
      grouped.set(row.provider, arr);
    }
    return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredModelRates]);
  const modelVendors = useMemo(
    () => [...new Set((data?.pricing.model_rates ?? []).map((r) => r.provider))].sort(),
    [data],
  );
  const sortedTools = useMemo(() => {
    if (!data) return [];
    const rows = [...data.top_tools];
    rows.sort((a, b) => {
      if (toolSort === "calls_desc") {
        if (b.call_count !== a.call_count) return b.call_count - a.call_count;
      } else if (toolSort === "errors_desc") {
        if (b.error_count !== a.error_count) return b.error_count - a.error_count;
      } else if (toolSort === "error_rate_desc") {
        const aRate = a.call_count > 0 ? a.error_count / a.call_count : 0;
        const bRate = b.call_count > 0 ? b.error_count / b.call_count : 0;
        if (bRate !== aRate) return bRate - aRate;
      } else if (toolSort === "name_asc") {
        return a.name.localeCompare(b.name);
      } else {
        if (b.score !== a.score) return b.score - a.score;
        if (b.success_rate !== a.success_rate) return b.success_rate - a.success_rate;
        if (b.call_count !== a.call_count) return b.call_count - a.call_count;
      }
      return a.name.localeCompare(b.name);
    });
    return rows;
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

      <div className="relative rounded-2xl border border-[var(--border)] bg-gradient-to-br from-[var(--bg-secondary)] to-[var(--bg-primary)]/60 p-4 md:p-5 shadow-sm">
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

      <div className="relative flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 px-3 py-2.5 shadow-sm">
        <span className="text-xs text-[var(--text-secondary)]">Currency</span>
        <select
          value={currencyMode}
          onChange={(e) => setCurrencyMode(e.target.value as CurrencyMode)}
          className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]"
        >
          <option value="auto">Auto by location</option>
          <option value="manual">Manual override</option>
        </select>
        <select
          value={manualCurrency}
          onChange={(e) => setManualCurrency(e.target.value)}
          disabled={currencyMode !== "manual"}
          className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)] disabled:opacity-50"
        >
          {MANUAL_CURRENCIES.map((code) => (
            <option key={code} value={code}>{code}</option>
          ))}
        </select>
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
            <MetricCard label="Input tokens (est)" value={formatInt(data.summary.input_tokens_est)} icon={<BarChart3 size={15} />} />
            <MetricCard label="Output tokens (est)" value={formatInt(data.summary.output_tokens_est)} icon={<TrendingUp size={15} />} />
            <MetricCard
              label={`Estimated cost (${currencyInfo.currency})`}
              value={formatMoney(data.summary.estimated_cost_usd, currencyInfo)}
              icon={<Coins size={15} />}
            />
            <MetricCard label="Tool success rate" value={`${(data.summary.success_rate * 100).toFixed(1)}%`} icon={<ShieldCheck size={15} />} />
            <MetricCard label="Tool error rate" value={`${(data.summary.error_rate * 100).toFixed(1)}%`} icon={<Activity size={15} />} />
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
            <InteractiveTokenChart series={series} />
          </section>

          <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-4 shadow-sm">
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">Estimated cost over time</h3>
            <InteractiveCostChart series={series} currencyInfo={currencyInfo} />
          </section>

          <div className="grid md:grid-cols-2 gap-4">
            <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-4 shadow-sm">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-[var(--text-primary)]">Favorite tools</h3>
                <select
                  value={toolSort}
                  onChange={(e) => setToolSort(e.target.value as typeof toolSort)}
                  className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]"
                >
                  <option value="best">Sort: best first</option>
                  <option value="calls_desc">Sort: most calls</option>
                  <option value="errors_desc">Sort: most errors</option>
                  <option value="error_rate_desc">Sort: highest error rate</option>
                  <option value="name_asc">Sort: name A→Z</option>
                </select>
              </div>
              <div className="space-y-2">
                {sortedTools.length === 0 ? (
                  <p className="text-xs text-[var(--text-secondary)]">No tool calls recorded yet.</p>
                ) : (
                  sortedTools.map((tool) => (
                    <div key={tool.name} className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)]/45 px-3 py-2">
                      <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm text-[var(--text-primary)]">{tool.name}</div>
                          <div className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
                            score {tool.score.toFixed(2)} · {(tool.success_rate * 100).toFixed(1)}% success · {tool.call_count} calls · {tool.error_count} errors
                          </div>
                        </div>
                        <span className={`rounded border px-1.5 py-0.5 text-[10px] ${
                          tool.score >= 0.85
                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                            : tool.score >= 0.65
                            ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                            : "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300"
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
              <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">Agent cost hotspots</h3>
              <AgentCostPie agents={data.top_agents.slice(0, 6)} currencyInfo={currencyInfo} />
            </section>
          </div>

          <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-4 space-y-3 shadow-sm">
            <h3 className="text-sm font-medium text-[var(--text-primary)]">Vendor and model report</h3>
            <div className="grid lg:grid-cols-2 gap-3">
              <BreakdownPiePanel
                title="By vendor"
                emptyLabel="No vendor breakdown data yet."
                items={data.by_provider.slice(0, 12).map((row) => ({
                  id: row.provider,
                  label: row.provider,
                  cost: row.estimated_cost_usd,
                  detail: `${formatInt(row.message_count)} msgs · ${formatInt(row.input_tokens_est + row.output_tokens_est)} tokens`,
                }))}
                currencyInfo={currencyInfo}
              />

              <BreakdownPiePanel
                title="By model config"
                emptyLabel="No model breakdown data yet."
                items={data.by_model.slice(0, 16).map((row) => ({
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
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)]/35 overflow-hidden">
              <div className="px-3 py-2 border-b border-[var(--border)] text-xs font-medium text-[var(--text-primary)]">
                Model pricing (detected)
              </div>
              <div className="border-b border-[var(--border)] px-3 py-2">
                <div className="grid gap-2 md:grid-cols-[160px_1fr_180px]">
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
                      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-[var(--bg-secondary)]/95 px-3 py-1.5 text-[11px] font-medium text-[var(--text-primary)] backdrop-blur">
                        <span>{provider}</span>
                        <span className="text-[var(--text-secondary)]">{rows.length} model{rows.length === 1 ? "" : "s"}</span>
                      </div>
                      {rows.map((row) => (
                        <div key={`${row.provider}:${row.model_id}`} className="px-3 py-2 border-t border-[var(--border)]/40">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm text-[var(--text-primary)] truncate">{row.model_id}</span>
                            <span className="text-[11px] text-[var(--text-secondary)]">
                              in ${row.input_per_1m_usd?.toFixed(2) ?? "n/a"} · out ${row.output_per_1m_usd?.toFixed(2) ?? "n/a"}
                            </span>
                          </div>
                          <div className="mt-1 text-[10px] text-[var(--text-secondary)] flex items-center gap-2">
                            <span>{row.inferred ? "inferred" : "explicit"}</span>
                            <span>·</span>
                            <span>confidence {row.confidence}</span>
                            {safeHttpUrl(row.source) ? (
                              <>
                                <span>·</span>
                                <a href={row.source} target="_blank" rel="noreferrer" className="text-cyan-600 hover:underline dark:text-cyan-400">source</a>
                              </>
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
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/95 px-3 py-3 shadow-sm">
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
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/80 px-3 py-2.5 shadow-sm">
      <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)]">{label}</div>
      <div className="mt-1 text-base font-semibold text-[var(--text-primary)]">{value}</div>
      <div className="mt-0.5 text-[11px] text-[var(--text-secondary)]">{hint}</div>
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
  const radius = 78;
  const cx = 92;
  const cy = 92;
  const fractions = agents.map((agent) => {
    const value = Math.max(0, agent.estimated_cost_usd);
    return total > 0 ? value / total : 1 / agents.length;
  });

  const slices = agents.map((agent, idx) => {
    const value = Math.max(0, agent.estimated_cost_usd);
    const fraction = fractions[idx];
    const startAngle = -Math.PI / 2 + fractions.slice(0, idx).reduce((sum, f) => sum + f, 0) * Math.PI * 2;
    const sweep = fraction * Math.PI * 2;
    const endAngle = startAngle + sweep;
    const largeArc = sweep > Math.PI ? 1 : 0;
    const x1 = cx + radius * Math.cos(startAngle);
    const y1 = cy + radius * Math.sin(startAngle);
    const x2 = cx + radius * Math.cos(endAngle);
    const y2 = cy + radius * Math.sin(endAngle);
    return {
      idx,
      agent,
      value,
      fraction,
      path: `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`,
      color: colors[idx % colors.length],
    };
  });

  const active = hovered != null ? slices[hovered] : null;

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[190px_1fr]">
      <div className="relative mx-auto w-[190px]">
        <svg viewBox="0 0 184 184" className="h-[190px] w-[190px]" role="img" aria-label="Agent cost share pie chart">
          <circle cx={cx} cy={cy} r={radius} fill="rgba(148,163,184,0.12)" />
          {slices.map((slice) => (
            <path
              key={slice.agent.agent_id}
              d={slice.path}
              fill={slice.color}
              opacity={hovered == null || hovered === slice.idx ? 0.95 : 0.45}
              stroke="rgba(15,23,42,0.45)"
              strokeWidth="1"
              onMouseEnter={() => setHovered(slice.idx)}
              onMouseLeave={() => setHovered(null)}
            />
          ))}
          <circle cx={cx} cy={cy} r={46} fill="var(--bg-secondary)" />
        </svg>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center">
          <div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)]">Window cost</div>
            <div className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{formatMoney(total, currencyInfo)}</div>
            {active ? (
              <div className="mt-1 text-[11px] text-[var(--text-secondary)]">
                {(active.fraction * 100).toFixed(1)}% {active.agent.agent_name}
              </div>
            ) : null}
          </div>
        </div>
      </div>

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
  const r = 52;
  const cx = 64;
  const cy = 64;
  const fractions = items.map((item) => {
    const value = Math.max(0, item.cost);
    return total > 0 ? value / total : 1 / items.length;
  });

  const slices = items.map((item, idx) => {
    const value = Math.max(0, item.cost);
    const fraction = fractions[idx];
    const startAngle = -Math.PI / 2 + fractions.slice(0, idx).reduce((sum, f) => sum + f, 0) * Math.PI * 2;
    const sweep = fraction * Math.PI * 2;
    const endAngle = startAngle + sweep;
    const largeArc = sweep > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    return {
      ...item,
      idx,
      value,
      fraction,
      color: palette[idx % palette.length],
      path: `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`,
    };
  });

  const active = hovered != null ? slices[hovered] : null;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)]/35 p-3">
      <div className="mb-2 text-xs font-medium text-[var(--text-primary)]">{title}</div>
      <div className="grid grid-cols-[136px_1fr] gap-3">
        <div className="relative">
          <svg viewBox="0 0 128 128" className="h-[136px] w-[136px]" role="img" aria-label={`${title} pie chart`}>
            <circle cx={cx} cy={cy} r={r} fill="rgba(148,163,184,0.12)" />
            {slices.map((slice) => (
              <path
                key={slice.id}
                d={slice.path}
                fill={slice.color}
                opacity={hovered == null || hovered === slice.idx ? 0.95 : 0.45}
                stroke="rgba(15,23,42,0.45)"
                strokeWidth="1"
                onMouseEnter={() => setHovered(slice.idx)}
                onMouseLeave={() => setHovered(null)}
              />
            ))}
            <circle cx={cx} cy={cy} r={30} fill="var(--bg-secondary)" />
          </svg>
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center">
            <div>
              <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)]">Total</div>
              <div className="mt-0.5 text-[11px] font-semibold text-[var(--text-primary)]">{formatMoney(total, currencyInfo)}</div>
            </div>
          </div>
        </div>

        <div className="max-h-56 space-y-1.5 overflow-auto pr-1">
          {slices.map((slice) => (
            <div
              key={slice.id}
              onMouseEnter={() => setHovered(slice.idx)}
              onMouseLeave={() => setHovered(null)}
              className={`rounded-md border px-2.5 py-2 ${
                hovered === slice.idx
                  ? "border-[var(--accent)]/50 bg-[var(--bg-primary)]/70"
                  : "border-[var(--border)] bg-[var(--bg-primary)]/45"
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
          {active ? (
            <div className="text-[10px] text-[var(--text-secondary)]">
              Highlighted: {active.label} ({(active.fraction * 100).toFixed(1)}%)
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function InteractiveTokenChart({ series }: { series: DashboardMetrics["series"] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const maxTotal = series.reduce((max, p) => Math.max(max, p.input_tokens_est + p.output_tokens_est), 0);
  const active = hovered != null ? series[hovered] : null;

  if (series.length === 0) {
    return <p className="text-xs text-[var(--text-secondary)]">No token data yet.</p>;
  }

  return (
    <div>
      <div className="relative h-48 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)]/45 p-2 shadow-inner">
        <div className="absolute right-2 top-2 text-[11px] text-[var(--text-secondary)]">
          {active ? `${active.day}  ${formatInt(active.input_tokens_est + active.output_tokens_est)} tokens` : "Hover bars for details"}
        </div>
        <div className="h-full flex items-end gap-1 pt-5">
          {series.map((point, idx) => {
            const total = point.input_tokens_est + point.output_tokens_est;
            const totalHeight = maxTotal > 0 ? Math.max(6, Math.round((total / maxTotal) * 150)) : 6;
            const inputHeight = total > 0 ? Math.max(2, Math.round((point.input_tokens_est / total) * totalHeight)) : 0;
            const outputHeight = Math.max(2, totalHeight - inputHeight);
            const isActive = idx === hovered;
            return (
              <div
                key={point.day}
                onMouseEnter={() => setHovered(idx)}
                onMouseLeave={() => setHovered(null)}
                className="flex-1 min-w-0 h-full flex flex-col items-center justify-end"
                aria-label={`${point.day} tokens (informational)`}
              >
                <div className={`w-full rounded-t overflow-hidden border transition-colors ${isActive ? "border-cyan-300/60 shadow-[0_0_0_1px_rgba(34,211,238,0.35)]" : "border-transparent"}`}>
                  <div className="w-full bg-gradient-to-t from-sky-500 to-cyan-400" style={{ height: `${outputHeight}px` }} />
                  <div className="w-full bg-gradient-to-t from-indigo-500 to-violet-400" style={{ height: `${inputHeight}px` }} />
                </div>
                <span className="mt-1 text-[10px] text-[var(--text-secondary)] truncate w-full text-center">
                  {point.day.slice(5)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-[var(--text-secondary)]">
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-violet-400" />input</span>
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-cyan-400" />output</span>
        {active && (
          <span className="ml-auto text-[var(--text-primary)]">
            in {formatInt(active.input_tokens_est)} · out {formatInt(active.output_tokens_est)}
          </span>
        )}
      </div>
    </div>
  );
}

function InteractiveCostChart({
  series,
  currencyInfo,
}: {
  series: DashboardMetrics["series"];
  currencyInfo: DashboardCurrencyInfo;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
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

  if (series.length === 0) {
    return <p className="text-xs text-[var(--text-secondary)]">No cost data yet.</p>;
  }

  return (
    <div>
      <div className="relative rounded-xl border border-[var(--border)] bg-[var(--bg-primary)]/45 p-2 shadow-inner">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-48" role="img" aria-label="Estimated cost over time">
          <line x1={padX} y1={height - padY} x2={width - padX} y2={height - padY} stroke="rgba(148,163,184,0.45)" strokeWidth="1" />
          <line x1={padX} y1={padY} x2={padX} y2={height - padY} stroke="rgba(148,163,184,0.25)" strokeWidth="1" />
          <polyline fill="none" stroke="rgba(16,185,129,0.95)" strokeWidth="2.6" points={polyline} />
          {points.map((pt) => {
            const isActive = pt.idx === hovered;
            return (
              <g key={pt.p.day}>
                {isActive && <line x1={pt.x} y1={padY} x2={pt.x} y2={height - padY} stroke="rgba(20,184,166,0.35)" strokeWidth="1.5" />}
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={3.8}
                  fill={isActive ? "rgba(16,185,129,1)" : "rgba(52,211,153,0.85)"}
                  onMouseEnter={() => setHovered(pt.idx)}
                  onMouseLeave={() => setHovered(null)}
                />
              </g>
            );
          })}
        </svg>
        <div className="absolute right-3 top-3 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/85 px-2 py-1 text-[11px]">
          {active
            ? `${active.p.day}  ${formatMoney(active.p.estimated_cost_usd, currencyInfo)}`
            : "Hover points for day cost"}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-[var(--text-secondary)]">
        <span>
          min: {formatMoney(Math.min(...series.map((s) => s.estimated_cost_usd)), currencyInfo)}
        </span>
        <span className="text-center">
          max: {formatMoney(Math.max(...series.map((s) => s.estimated_cost_usd)), currencyInfo)}
        </span>
        <span className="text-right">
          window total: {formatMoney(series.reduce((sum, s) => sum + s.estimated_cost_usd, 0), currencyInfo)}
        </span>
      </div>
    </div>
  );
}

function convertUsd(usd: number, currencyInfo: DashboardCurrencyInfo): number {
  return usd * (currencyInfo.rate_from_usd || 1);
}

function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function formatMoney(usd: number, currencyInfo: DashboardCurrencyInfo): string {
  const converted = convertUsd(usd, currencyInfo);
  const abs = Math.abs(converted);
  const useMicroPrecision = abs > 0 && abs < 0.01;
  const minFractionDigits = useMicroPrecision ? 4 : 2;
  const maxFractionDigits = useMicroPrecision ? 8 : 4;

  if (abs > 0 && abs < 0.000001) {
    try {
      const floor = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currencyInfo.currency || "USD",
        minimumFractionDigits: 6,
        maximumFractionDigits: 6,
      }).format(0.000001);
      return `< ${floor}`;
    } catch {
      return `${(currencyInfo.currency || "USD")} < 0.000001`;
    }
  }

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyInfo.currency || "USD",
      minimumFractionDigits: minFractionDigits,
      maximumFractionDigits: maxFractionDigits,
    }).format(converted);
  } catch {
    return `${(currencyInfo.currency || "USD")} ${converted.toFixed(maxFractionDigits)}`;
  }
}

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
