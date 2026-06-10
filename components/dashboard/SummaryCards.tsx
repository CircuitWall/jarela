"use client";
import { Activity, BarChart3, Coins, ShieldCheck, TrendingUp } from "lucide-react";
import type { DashboardCurrencyInfo, DashboardMetrics } from "@/api/types";
import { formatInt, formatMoney } from "@/lib/dashboard/format";
import { InsightChip, MetricCard } from "./Cards";

interface SummaryStripProps {
  data: DashboardMetrics;
  currencyInfo: DashboardCurrencyInfo;
  windowTokenTotal: number;
  activeDays: number;
  avgDailyTokens: number;
  avgDailyCostUsd: number;
}

export function SummaryStrip({ data, currencyInfo, windowTokenTotal, activeDays, avgDailyTokens, avgDailyCostUsd }: SummaryStripProps) {
  return (
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
  );
}

interface EffectiveSummary {
  input_tokens_est: number;
  output_tokens_est: number;
  estimated_cost_usd: number;
  success_rate: number;
  error_rate: number;
}

interface MetricCardsGridProps {
  effectiveSummary: EffectiveSummary | undefined;
  currencyInfo: DashboardCurrencyInfo;
  selectedDay: string | null;
}

export function MetricCardsGrid({ effectiveSummary, currencyInfo, selectedDay }: MetricCardsGridProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
      <MetricCard
        label={selectedDay ? `Input tokens on ${selectedDay}` : "Input tokens (est)"}
        value={formatInt(effectiveSummary?.input_tokens_est ?? 0)}
        icon={<BarChart3 size={15} />}
      />
      <MetricCard
        label={selectedDay ? `Output tokens on ${selectedDay}` : "Output tokens (est)"}
        value={formatInt(effectiveSummary?.output_tokens_est ?? 0)}
        icon={<TrendingUp size={15} />}
      />
      <MetricCard
        label={selectedDay ? `Cost on ${selectedDay} (${currencyInfo.currency})` : `Estimated cost (${currencyInfo.currency})`}
        value={formatMoney(effectiveSummary?.estimated_cost_usd ?? 0, currencyInfo)}
        icon={<Coins size={15} />}
      />
      <MetricCard
        label="Tool success rate"
        value={`${((effectiveSummary?.success_rate ?? 1) * 100).toFixed(1)}%`}
        icon={<ShieldCheck size={15} />}
      />
      <MetricCard
        label="Tool error rate"
        value={`${((effectiveSummary?.error_rate ?? 0) * 100).toFixed(1)}%`}
        icon={<Activity size={15} />}
      />
    </div>
  );
}
