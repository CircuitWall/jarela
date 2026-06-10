import type { DashboardCurrencyInfo } from "@/api/types";

export type WindowDays = 7 | 14 | 30 | 60;
export type CurrencyMode = "auto" | "manual";

export const WINDOWS: WindowDays[] = [7, 14, 30, 60];
export const MANUAL_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CNY", "INR", "BRL", "MXN"] as const;

export const TOOL_SORT_OPTIONS = [
  { value: "best", label: "Sort: best first" },
  { value: "calls_desc", label: "Sort: most calls" },
  { value: "errors_desc", label: "Sort: most errors" },
  { value: "error_rate_desc", label: "Sort: highest error rate" },
  { value: "name_asc", label: "Sort: name A->Z" },
] as const;

export const MODEL_SORT_OPTIONS = [
  { value: "model_asc", label: "Sort: model A->Z" },
  { value: "model_desc", label: "Sort: model Z->A" },
  { value: "input_desc", label: "Sort: highest input rate" },
  { value: "input_asc", label: "Sort: lowest input rate" },
  { value: "output_desc", label: "Sort: highest output rate" },
  { value: "output_asc", label: "Sort: lowest output rate" },
  { value: "confidence_desc", label: "Sort: confidence" },
  { value: "confidence_asc", label: "Sort: lowest confidence" },
] as const;

export const CURRENCY_MODE_KEY = "jarela.dashboard.currency.mode";
export const CURRENCY_PICK_KEY = "jarela.dashboard.currency.pick";

export const USD_CURRENCY: DashboardCurrencyInfo = {
  currency: "USD",
  rate_from_usd: 1,
  country_code: null,
  source: "default",
  updated_at: "",
};

// Per-tier breakdown colors shared by the stacked token chart legend.
export const TIER_COLORS: Record<"hot" | "warm" | "facts" | "overhead", string> = {
  hot: "#22d3ee",
  warm: "#f59e0b",
  facts: "#a78bfa",
  overhead: "#94a3b8",
};
