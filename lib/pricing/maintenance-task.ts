export const WEEKLY_PRICING_TASK_ID = "jarela-weekly-pricing-refresh";
export const WEEKLY_PRICING_TASK_CRON = "0 9 * * 1";
export const WEEKLY_PRICING_TASK_DESCRIPTION = "Weekly LLM pricing refresh and dashboard estimate update";
export const WEEKLY_PRICING_TASK_PROMPT = [
  "Review LLM API pricing for the dashboard. Call refresh_model_pricing once and use its result as the source of truth for this run.",
  "The tool refreshes configured pricing sources, trying provider pages first and search fallbacks when needed, then recalculates dashboard estimates using captured token usage and current rates. Original per-turn recorded cost snapshots are not changed.",
  "Never describe a calculated estimate as an actual provider invoice. Report changed rates, low-confidence model IDs, and source failures. A model not returned by the current extraction may be an extraction gap, not a confirmed provider removal. If there are no rate changes or low-confidence rates and every source succeeded, reply NO_REPLY.",
].join("\n\n");