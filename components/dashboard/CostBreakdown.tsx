import type { DashboardCostBreakdown, DashboardCurrencyInfo } from "@/api/types";
import { formatMoney } from "@/lib/dashboard/format";

export function CostBreakdown({ costs, currencyInfo }: {
  costs: DashboardCostBreakdown;
  currencyInfo: DashboardCurrencyInfo;
}) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums text-[var(--text-secondary)]">
      <span title="Input cost includes prompt-cache read and write charges.">
        Input cost: {formatMoney(costs.input_cost_usd, currencyInfo)}
      </span>
      <span>Output cost: {formatMoney(costs.output_cost_usd, currencyInfo)}</span>
      {costs.unattributed_cost_usd !== 0 ? (
        <span title="Recorded cost retained because matching rates are unavailable; the input/output split is unknown.">
          Unattributed cost: {formatMoney(costs.unattributed_cost_usd, currencyInfo)}
        </span>
      ) : null}
    </div>
  );
}
