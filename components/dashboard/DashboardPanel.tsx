"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { DashboardCurrencyInfo, DashboardMetrics, UserProfile } from "@/api/types";

type WindowDays = 7 | 14 | 30 | 60;

const WINDOWS: WindowDays[] = [7, 14, 30, 60];

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

  useEffect(() => {
    let cancelled = false;

    api.profile.get()
      .then((profile: UserProfile) => {
        const lat = profile.location_lat;
        const lng = profile.location_lng;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          if (!cancelled) setCurrencyInfo(USD_CURRENCY);
          return;
        }
        return api.dashboard.currency(lat as number, lng as number).then((resolved) => {
          if (!cancelled) setCurrencyInfo(resolved);
        });
      })
      .catch(() => {
        if (!cancelled) setCurrencyInfo(USD_CURRENCY);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const series = useMemo(() => data?.series ?? [], [data]);

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Usage dashboard</h2>
          <p className="text-xs text-[var(--text-secondary)]">
            Estimated token usage, cost, and tool reliability trends.
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-1">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setDays(w)}
              className={
                "px-2.5 py-1 text-xs rounded-md transition-colors " +
                (w === days
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]")
              }
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-sm text-[var(--text-secondary)]">
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
            <MetricCard label="Input tokens (est)" value={formatInt(data.summary.input_tokens_est)} />
            <MetricCard label="Output tokens (est)" value={formatInt(data.summary.output_tokens_est)} />
            <MetricCard
              label={`Estimated cost (${currencyInfo.currency})`}
              value={formatMoney(data.summary.estimated_cost_usd, currencyInfo)}
            />
            <MetricCard label="Tool success rate" value={`${(data.summary.success_rate * 100).toFixed(1)}%`} />
            <MetricCard label="Tool error rate" value={`${(data.summary.error_rate * 100).toFixed(1)}%`} />
          </div>

          <p className="text-[11px] text-[var(--text-secondary)]">
            {currencyInfo.source === "location"
              ? `Currency converted from USD to ${currencyInfo.currency} based on saved location.`
              : "Currency defaults to USD because no location-based currency is available."}
          </p>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">Token usage over time</h3>
            <InteractiveTokenChart series={series} />
          </section>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">Estimated cost over time</h3>
            <InteractiveCostChart series={series} currencyInfo={currencyInfo} />
          </section>

          <div className="grid md:grid-cols-2 gap-4">
            <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
              <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">Favorite tools</h3>
              <div className="space-y-2">
                {data.top_tools.length === 0 ? (
                  <p className="text-xs text-[var(--text-secondary)]">No tool calls recorded yet.</p>
                ) : (
                  data.top_tools.slice(0, 6).map((tool) => (
                    <div key={tool.name} className="rounded-lg border border-[var(--border)] px-3 py-2">
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

            <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
              <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">Agent cost hotspots</h3>
              <div className="space-y-2">
                {data.top_agents.length === 0 ? (
                  <p className="text-xs text-[var(--text-secondary)]">No recent traffic yet.</p>
                ) : (
                  data.top_agents.slice(0, 6).map((agent) => (
                    <div key={agent.agent_id} className="rounded-lg border border-[var(--border)] px-3 py-2">
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

          <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-2">
            <h3 className="text-sm font-medium text-[var(--text-primary)]">Pricing source and assumptions</h3>
            <p className="text-xs text-[var(--text-secondary)]">
              Snapshot: {data.pricing.snapshot_generated_at ?? "not found"}
            </p>
            <div className="grid md:grid-cols-2 gap-2">
              {data.pricing.rates.map((row) => (
                <div key={row.provider} className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
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

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-3">
      <p className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</p>
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
      <div className="relative h-48 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)]/40 p-2">
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
      <div className="relative rounded-xl border border-[var(--border)] bg-[var(--bg-primary)]/40 p-2">
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
