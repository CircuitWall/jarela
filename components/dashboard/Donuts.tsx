"use client";
import { useEffect, useId, useState } from "react";
import type { DashboardCurrencyInfo, DashboardMetrics } from "@/api/types";
import { withAlpha } from "@/lib/dashboard/color";
import { arcPath } from "@/lib/dashboard/geometry";
import { formatInt, formatMoney, formatMoneyCompact } from "@/lib/dashboard/format";

export type DonutSlice = {
  id: string;
  label: string;
  value: number;
  color: string;
};

interface DonutProps {
  ariaLabel: string;
  size: number;
  centerAmount: string;
  slices: DonutSlice[];
  hovered: number | null;
  onHoverChange: (index: number | null) => void;
}

export function SharedDonutChart({ ariaLabel, size, centerAmount, slices, hovered, onHoverChange }: DonutProps) {
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

  useEffect(() => { setAnimCycle((v) => v + 1); }, [animationSignature]);

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
    return { ...slice, idx, fraction, path: arcPath(cx, cy, radius, arcStart, arcEnd) };
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
                <animate attributeName="stroke-dashoffset" from="100" to="0" dur="620ms" begin={`${segment.idx * 65}ms`} fill="freeze" />
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
          active ? "bg-[var(--bg-primary)]/60 text-[var(--text-primary)] opacity-100" : "bg-transparent text-[var(--text-secondary)] opacity-60"
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

const AGENT_PALETTE = ["#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444"];

interface AgentCostPieProps {
  agents: DashboardMetrics["top_agents"];
  currencyInfo: DashboardCurrencyInfo;
}

export function AgentCostPie({ agents, currencyInfo }: AgentCostPieProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  if (agents.length === 0) {
    return <p className="text-xs text-[var(--text-secondary)]">No recent traffic yet.</p>;
  }
  const total = agents.reduce((sum, a) => sum + Math.max(0, a.estimated_cost_usd), 0);
  const fractions = agents.map((agent) => {
    const value = Math.max(0, agent.estimated_cost_usd);
    return total > 0 ? value / total : 1 / agents.length;
  });
  const slices = agents.map((agent, idx) => ({
    idx,
    agent,
    value: Math.max(0, agent.estimated_cost_usd),
    fraction: fractions[idx],
    color: AGENT_PALETTE[idx % AGENT_PALETTE.length],
  }));

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

const BREAKDOWN_PALETTE = ["#14b8a6", "#22c55e", "#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444", "#06b6d4", "#84cc16"];

interface BreakdownPieProps {
  title: string;
  items: Array<{ id: string; label: string; cost: number; detail: string }>;
  currencyInfo: DashboardCurrencyInfo;
  emptyLabel: string;
}

export function BreakdownPiePanel({ title, items, currencyInfo, emptyLabel }: BreakdownPieProps) {
  const [hovered, setHovered] = useState<number | null>(null);

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
  const slices = items.map((item, idx) => ({
    ...item,
    idx,
    value: Math.max(0, item.cost),
    fraction: fractions[idx],
    color: BREAKDOWN_PALETTE[idx % BREAKDOWN_PALETTE.length],
  }));

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
          slices={slices.map((slice) => ({ id: slice.id, label: slice.label, value: slice.value, color: slice.color }))}
        />
        <div className="max-h-56 space-y-1.5 overflow-auto pr-1">
          {slices.map((slice) => (
            <div
              key={slice.id}
              onMouseEnter={() => setHovered(slice.idx)}
              onMouseLeave={() => setHovered(null)}
              className={`rounded-md px-2.5 py-2 ${
                hovered === slice.idx ? "bg-[var(--bg-primary)]/70" : "bg-[var(--bg-primary)]/35"
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
