"use client";
import { useEffect, useState } from "react";
import type { DashboardCurrencyInfo, DashboardMetrics } from "@/api/types";
import { convertUsd, formatInt, formatMoney, formatMoneyCompact } from "@/lib/dashboard/format";
import { TIER_COLORS } from "./dashboard-constants";

interface TokenChartProps {
  series: DashboardMetrics["series"];
  selectedDay?: string | null;
  onSelectDay?: (day: string) => void;
}

export function InteractiveTokenChart({ series, selectedDay, onSelectDay }: TokenChartProps) {
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
            active ? "bg-[var(--bg-secondary)]/85 text-[var(--text-primary)] opacity-100" : "text-[var(--text-secondary)] opacity-60"
          }`}
        >
          {active
            ? `${active.day} · ${formatInt(active.input_tokens_est + active.output_tokens_est)} tokens`
            : "hover bars for details"}
        </div>
        <div className="h-full flex items-end gap-1 pt-5">
          {series.map((point, idx) => (
            <TokenBar
              key={point.day}
              point={point}
              idx={idx}
              maxTotal={maxTotal}
              barsReady={barsReady}
              hovered={hovered === idx}
              selected={selectedDay === point.day}
              onHover={setHovered}
              onSelectDay={onSelectDay}
            />
          ))}
        </div>
      </div>
      <TokenChartLegend active={active} />
    </div>
  );
}

interface TokenBarProps {
  point: DashboardMetrics["series"][number];
  idx: number;
  maxTotal: number;
  barsReady: boolean;
  hovered: boolean;
  selected: boolean;
  onHover: (i: number | null) => void;
  onSelectDay?: (day: string) => void;
}

function TokenBar({ point, idx, maxTotal, barsReady, hovered, selected, onHover, onSelectDay }: TokenBarProps) {
  const total = point.input_tokens_est + point.output_tokens_est;
  const hasData = total > 0;
  const totalHeight = hasData && maxTotal > 0 ? Math.max(4, Math.round((total / maxTotal) * 150)) : 0;
  const inputHeight = hasData ? Math.round((point.input_tokens_est / total) * totalHeight) : 0;
  const outputHeight = hasData ? Math.max(0, totalHeight - inputHeight) : 0;
  // Subdivide the input portion by measured tier breakdown when the day
  // has at least one snapshotted assistant turn. Legacy days (measured
  // input == 0) fall back to a solid violet block.
  const tier = point.tier_tokens;
  const tierTotal = tier?.measured_input_tokens ?? 0;
  const hotPx = tierTotal > 0 ? Math.round((tier.hot_tokens / tierTotal) * inputHeight) : 0;
  const warmPx = tierTotal > 0 ? Math.round((tier.warm_tokens / tierTotal) * inputHeight) : 0;
  const factsPx = tierTotal > 0 ? Math.round((tier.facts_tokens / tierTotal) * inputHeight) : 0;
  const overheadPx = tierTotal > 0 ? Math.max(0, inputHeight - hotPx - warmPx - factsPx) : 0;
  const clickable = !!onSelectDay && hasData;
  const tieredSegments = [
    { color: TIER_COLORS.hot, height: hotPx, delay: 30 },
    { color: TIER_COLORS.warm, height: warmPx, delay: 42 },
    { color: TIER_COLORS.facts, height: factsPx, delay: 54 },
    { color: TIER_COLORS.overhead, height: overheadPx, delay: 66 },
  ];

  return (
    <div
      onMouseEnter={() => onHover(idx)}
      onMouseLeave={() => onHover(null)}
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
      aria-pressed={clickable ? selected : undefined}
    >
      <div className={`w-full rounded-t overflow-hidden border transition-colors ${
        selected
          ? "border-[var(--accent)]/70 shadow-[0_0_0_1px_var(--accent)]"
          : hovered
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
              tieredSegments.map((seg, i) => (
                <div
                  key={i}
                  className="w-full"
                  style={{
                    background: seg.color,
                    height: barsReady ? `${seg.height}px` : "0px",
                    transition: `height 420ms cubic-bezier(0.2, 0.8, 0.2, 1) ${idx * 18 + seg.delay}ms`,
                  }}
                />
              ))
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
}

function TokenChartLegend({ active }: { active: DashboardMetrics["series"][number] | null }) {
  return (
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
  );
}

interface CostChartProps {
  series: DashboardMetrics["series"];
  currencyInfo: DashboardCurrencyInfo;
  selectedDay?: string | null;
  onSelectDay?: (day: string) => void;
}

export function InteractiveCostChart({ series, currencyInfo, selectedDay, onSelectDay }: CostChartProps) {
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

  useEffect(() => { setLineAnimCycle((v) => v + 1); }, [animationSignature, selectedDay]);

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
              <line key={frac} x1={padX} y1={y} x2={width - padX} y2={y} stroke="rgba(148,163,184,0.12)" strokeWidth="1" strokeDasharray="3 4" />
            );
          })}
          {[0.25, 0.5, 0.75, 1].map((frac) => {
            const y = padY + (1 - frac) * (height - padY * 2);
            const value = maxCost * frac;
            return (
              <text key={`tick-${frac}`} x={padX - 4} y={y + 3} textAnchor="end" fill="currentColor" className="fill-[var(--text-secondary)] text-[8px]">
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
          {points.map((pt) => (
            <CostPoint
              key={pt.p.day}
              pt={pt}
              isActive={pt.idx === hovered}
              isSelected={pt.idx === selectedIdx}
              padY={padY}
              height={height}
              animCycle={lineAnimCycle}
              onHover={setHovered}
              onSelectDay={onSelectDay}
            />
          ))}
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

interface CostPointProps {
  pt: { x: number; y: number; p: DashboardMetrics["series"][number]; idx: number };
  isActive: boolean;
  isSelected: boolean;
  padY: number;
  height: number;
  animCycle: number;
  onHover: (i: number | null) => void;
  onSelectDay?: (day: string) => void;
}

function CostPoint({ pt, isActive, isSelected, padY, height, animCycle, onHover, onSelectDay }: CostPointProps) {
  return (
    <g>
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
        <circle cx={pt.x} cy={pt.y} r={8} fill="none" stroke="rgba(34,197,94,0.85)" strokeWidth={1.5}>
          <animate attributeName="r" from="3.8" to="9" dur="800ms" repeatCount="indefinite" />
          <animate attributeName="opacity" from="0.9" to="0" dur="800ms" repeatCount="indefinite" />
        </circle>
      )}
      <circle
        key={`${pt.p.day}-${animCycle}`}
        cx={pt.x}
        cy={pt.y}
        r={isSelected ? 5 : 3.8}
        fill={isSelected ? "rgba(34,197,94,1)" : isActive ? "rgba(16,185,129,1)" : "rgba(52,211,153,0.85)"}
        className={onSelectDay ? "cursor-pointer" : undefined}
        onMouseEnter={() => onHover(pt.idx)}
        onMouseLeave={() => onHover(null)}
        onClick={() => onSelectDay?.(pt.p.day)}
      >
        <animate attributeName="r" from="0" to={isSelected ? 5 : 3.8} dur="260ms" begin={`${pt.idx * 28}ms`} fill="freeze" />
      </circle>
    </g>
  );
}
