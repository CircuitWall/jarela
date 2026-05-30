"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { DashboardMetrics } from "@/api/types";

type WindowDays = 7 | 14 | 30 | 60;

const WINDOWS: WindowDays[] = [7, 14, 30, 60];

export function DashboardPanel() {
  const [days, setDays] = useState<WindowDays>(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DashboardMetrics | null>(null);

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

  const chartMeta = useMemo(() => {
    const series = data?.series ?? [];
    const maxTokens = series.reduce((max, p) => Math.max(max, p.input_tokens_est + p.output_tokens_est), 0);
    const maxCost = series.reduce((max, p) => Math.max(max, p.estimated_cost_usd), 0);
    return { maxTokens, maxCost };
  }, [data]);

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
            <MetricCard label="Estimated cost" value={`$${data.summary.estimated_cost_usd.toFixed(4)}`} />
            <MetricCard label="Tool success rate" value={`${(data.summary.success_rate * 100).toFixed(1)}%`} />
            <MetricCard label="Tool error rate" value={`${(data.summary.error_rate * 100).toFixed(1)}%`} />
          </div>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">Token usage over time</h3>
            <div className="h-44 flex items-end gap-1">
              {data.series.map((point) => {
                const total = point.input_tokens_est + point.output_tokens_est;
                const h = chartMeta.maxTokens > 0 ? Math.max(4, Math.round((total / chartMeta.maxTokens) * 160)) : 4;
                return (
                  <div key={point.day} className="flex-1 min-w-0 group flex flex-col items-center justify-end">
                    <div
                      className="w-full rounded-t bg-gradient-to-t from-cyan-500 to-blue-500/70"
                      style={{ height: `${h}px` }}
                      title={`${point.day}: ${formatInt(total)} tokens`}
                    />
                    <span className="mt-1 text-[10px] text-[var(--text-secondary)] truncate w-full text-center">
                      {point.day.slice(5)}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">Estimated cost over time</h3>
            <div className="h-32 flex items-end gap-1">
              {data.series.map((point) => {
                const h = chartMeta.maxCost > 0 ? Math.max(3, Math.round((point.estimated_cost_usd / chartMeta.maxCost) * 112)) : 3;
                return (
                  <div key={point.day} className="flex-1 min-w-0 flex flex-col items-center justify-end">
                    <div
                      className="w-full rounded-t bg-gradient-to-t from-emerald-500 to-teal-500/70"
                      style={{ height: `${h}px` }}
                      title={`${point.day}: $${point.estimated_cost_usd.toFixed(4)}`}
                    />
                  </div>
                );
              })}
            </div>
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
                        <span className="text-xs text-[var(--text-secondary)]">${agent.estimated_cost_usd.toFixed(4)}</span>
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

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
