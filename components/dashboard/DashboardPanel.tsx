"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { DashboardCurrencyInfo, DashboardMetrics, UserProfile } from "@/api/types";
import { Activity, BarChart3, Coins, RotateCw, ShieldCheck, TrendingUp } from "lucide-react";

type WindowDays = 7 | 14 | 30 | 60;
type CurrencyMode = "auto" | "manual";

const WINDOWS: WindowDays[] = [7, 14, 30, 60];
const MANUAL_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CNY", "INR", "BRL", "MXN"] as const;
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

  return (
    <div className="relative h-full overflow-y-auto p-4 md:p-6 space-y-4">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-20 -right-20 w-72 h-72 rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="absolute top-64 -left-24 w-80 h-80 rounded-full bg-emerald-500/10 blur-3xl" />
      </div>

      <div className="relative rounded-2xl border border-[var(--border)] bg-gradient-to-br from-[var(--bg-secondary)] to-[var(--bg-primary)]/60 p-4 md:p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">Usage dashboard</h2>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
            Estimated token usage, cost, and tool reliability trends.
            </p>
          </div>
          <div className="inline-flex rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-1 shadow-sm">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setDays(w)}
                className={
                  "px-2.5 py-1 text-xs rounded-lg transition-all " +
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
              <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">Favorite tools</h3>
              <div className="space-y-2">
                {data.top_tools.length === 0 ? (
                  <p className="text-xs text-[var(--text-secondary)]">No tool calls recorded yet.</p>
                ) : (
                  data.top_tools.slice(0, 6).map((tool) => (
                    <div key={tool.name} className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)]/45 px-3 py-2 transition-colors hover:bg-[var(--bg-primary)]/70">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-[var(--text-primary)] truncate">{tool.name}</span>
                        <span className="text-xs text-[var(--text-secondary)]">{tool.call_count} calls</span>
                      </div>
                      <div className="mt-1 text-xs text-[var(--text-secondary)]">
                        {(tool.success_rate * 100).toFixed(1)}% success · score {tool.score.toFixed(2)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-4 shadow-sm">
              <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">Agent cost hotspots</h3>
              <div className="space-y-2">
                {data.top_agents.length === 0 ? (
                  <p className="text-xs text-[var(--text-secondary)]">No recent traffic yet.</p>
                ) : (
                  data.top_agents.slice(0, 6).map((agent) => (
                    <div key={agent.agent_id} className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)]/45 px-3 py-2 transition-colors hover:bg-[var(--bg-primary)]/70">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-[var(--text-primary)] truncate">{agent.agent_name}</span>
                        <span className="text-xs text-[var(--text-secondary)]">
                          {formatMoney(agent.estimated_cost_usd, currencyInfo)}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-[var(--text-secondary)]">
                        {formatInt(agent.message_count)} msgs · {formatInt(agent.input_tokens_est + agent.output_tokens_est)} tokens
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>

          <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-4 space-y-3 shadow-sm">
            <h3 className="text-sm font-medium text-[var(--text-primary)]">Vendor and model report</h3>
            <div className="grid lg:grid-cols-2 gap-3">
              <div className="rounded-lg border border-[var(--border)] overflow-hidden bg-[var(--bg-primary)]/35">
                <div className="px-3 py-2 border-b border-[var(--border)] text-xs font-medium text-[var(--text-primary)]">
                  By vendor
                </div>
                <div className="max-h-56 overflow-auto">
                  {data.by_provider.length === 0 ? (
                    <p className="p-3 text-xs text-[var(--text-secondary)]">No vendor breakdown data yet.</p>
                  ) : (
                    data.by_provider.slice(0, 12).map((row) => (
                      <div key={row.provider} className="px-3 py-2 border-b border-[var(--border)]/60 last:border-b-0 transition-colors hover:bg-[var(--bg-primary)]/50">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm text-[var(--text-primary)] capitalize truncate">{row.provider}</span>
                          <span className="text-xs text-[var(--text-secondary)]">{formatMoney(row.estimated_cost_usd, currencyInfo)}</span>
                        </div>
                        <div className="mt-1 text-[11px] text-[var(--text-secondary)]">
                          {formatInt(row.message_count)} msgs · {formatInt(row.input_tokens_est + row.output_tokens_est)} tokens
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-[var(--border)] overflow-hidden bg-[var(--bg-primary)]/35">
                <div className="px-3 py-2 border-b border-[var(--border)] text-xs font-medium text-[var(--text-primary)]">
                  By model config
                </div>
                <div className="max-h-56 overflow-auto">
                  {data.by_model.length === 0 ? (
                    <p className="p-3 text-xs text-[var(--text-secondary)]">No model breakdown data yet.</p>
                  ) : (
                    data.by_model.slice(0, 16).map((row) => (
                      <div key={`${row.provider}:${row.model_config_name}:${row.model_id}`} className="px-3 py-2 border-b border-[var(--border)]/60 last:border-b-0 transition-colors hover:bg-[var(--bg-primary)]/50">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm text-[var(--text-primary)] truncate">{row.model_config_name}</span>
                          <span className="text-xs text-[var(--text-secondary)]">{formatMoney(row.estimated_cost_usd, currencyInfo)}</span>
                        </div>
                        <div className="mt-1 text-[11px] text-[var(--text-secondary)] truncate">
                          {row.provider}/{row.model_id} · {formatInt(row.message_count)} msgs
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 p-4 space-y-2 shadow-sm">
            <h3 className="text-sm font-medium text-[var(--text-primary)]">Pricing source and assumptions</h3>
            <p className="text-xs text-[var(--text-secondary)]">
              Snapshot: {data.pricing.snapshot_generated_at ?? "not found"}
            </p>
            <div className="grid md:grid-cols-2 gap-2">
              {data.pricing.rates.map((row) => (
                <div key={row.provider} className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)]/45 px-3 py-2 text-xs">
                  <div className="text-[var(--text-primary)] font-medium">{row.provider}</div>
                  <div className="text-[var(--text-secondary)]">
                    in ${row.input_per_1m_usd?.toFixed(2) ?? "n/a"} / 1M · out ${row.output_per_1m_usd?.toFixed(2) ?? "n/a"} / 1M
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-[var(--text-secondary)]">{data.pricing.notes}</p>
          </section>
        </>
      )}
    </div>
  );
}

function MetricCard({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/90 px-3 py-3 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
      <p className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)] inline-flex items-center gap-1.5">
        {icon ? <span className="text-[var(--text-secondary)]">{icon}</span> : null}
        {label}
      </p>
      <p className="mt-1 text-base font-semibold text-[var(--text-primary)]">{value}</p>
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
              <button
                key={point.day}
                type="button"
                onMouseEnter={() => setHovered(idx)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(idx)}
                onBlur={() => setHovered(null)}
                className="flex-1 min-w-0 h-full flex flex-col items-center justify-end group"
                aria-label={`${point.day} tokens`}
              >
                <div className={`w-full rounded-t overflow-hidden border transition-all ${isActive ? "border-cyan-300/60 shadow-[0_0_0_1px_rgba(34,211,238,0.35)]" : "border-transparent"}`}>
                  <div className="w-full bg-gradient-to-t from-sky-500 to-cyan-400" style={{ height: `${outputHeight}px` }} />
                  <div className="w-full bg-gradient-to-t from-indigo-500 to-violet-400" style={{ height: `${inputHeight}px` }} />
                </div>
                <span className="mt-1 text-[10px] text-[var(--text-secondary)] truncate w-full text-center">
                  {point.day.slice(5)}
                </span>
              </button>
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
                  r={isActive ? 4.8 : 3.2}
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

function formatMoney(usd: number, currencyInfo: DashboardCurrencyInfo): string {
  const converted = convertUsd(usd, currencyInfo);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyInfo.currency || "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(converted);
  } catch {
    return `${(currencyInfo.currency || "USD")} ${converted.toFixed(4)}`;
  }
}

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
