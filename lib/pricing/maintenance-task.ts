export const WEEKLY_PRICING_TASK_ID = "jarela-weekly-pricing-refresh";
export const WEEKLY_PRICING_TASK_CRON = "0 9 * * 1";
export const LEGACY_WEEKLY_PRICING_TASK_PROMPT = [
  "Review LLM API pricing for the dashboard. Call refresh_model_pricing once and use its result as the source of truth for this run.",
  "The tool refreshes configured pricing sources, trying provider pages first and search fallbacks when needed, then recalculates dashboard estimates using captured token usage and current rates. Original per-turn recorded cost snapshots are not changed.",
  "Never describe a calculated estimate as an actual provider invoice. Report changed rates, low-confidence model IDs, and source failures. A model not returned by the current extraction may be an extraction gap, not a confirmed provider removal. If there are no rate changes or low-confidence rates and every source succeeded, reply NO_REPLY.",
].join("\n\n");
export const WEEKLY_PRICING_TASK_DESCRIPTION = "Weekly LLM pricing, model version, and capability refresh";
export const WEEKLY_PRICING_TASK_PROMPT = [
  "Review LLM API pricing and model updates for the dashboard. Call refresh_model_pricing once with deadline_ms=900000 because this checks multiple documentation pages and invokes the configured extractor. Use its result as the source of truth for this run; if it times out, do not start a duplicate refresh while the first call may still be running.",
  "The tool refreshes pricing sources and reads official model/API documentation, then updates source-backed model version and capability display metadata and recalculates dashboard estimates. It does not change saved model IDs, runtime settings, credentials, or original per-turn cost snapshots.",
  "Validate the result before reporting: inspect changed_rates, not_returned_rates, sources, aggregators, and model_updates (sources, changed_models, changed_provider_features, adoption_required). Report model/version, capability, and standalone provider API changes with their source URLs, low-confidence rates, extraction gaps, truncated model-update sources, and every source failure. first_observed means newly tracked, not necessarily newly released. Missing model/capability observations are not evidence of removal. Advertised API capabilities are not proof of Jarela runtime support; a standalone Search API is not a model-native search mode.",
  "For model_updates.adoption_required, inspect the relevant Jarela adapter/runtime code if source access is available. If code changes are confirmed necessary, use enabled GitHub tools to search CircuitWall/jarela for an existing issue (including closed issues) for the same provider/model/feature before creating one. Reuse an open issue; do not duplicate a completed issue without evidence of a remaining gap. File a focused adoption issue with public official source URLs, the API capability, confirmed code gap, and acceptance criteria. Never include credentials, local paths, private configs, transcripts, or page dumps. Report the issue URL only after creation succeeds. If code access, GitHub access, or approval is missing, return the candidate and blocker explicitly; do not claim an issue was filed.",
  "Never describe a calculated estimate as an actual provider invoice. Reply NO_REPLY only if there are no rate changes, extraction gaps, low-confidence rates, model/version/capability changes, standalone API changes, adoption candidates, truncated sources, or source failures (including aggregator and model-update sources).",
].join("\n\n");

export function weeklyPricingTaskUpgrade(task: { id: string; prompt: string; description: string | null }) {
  if (task.id !== WEEKLY_PRICING_TASK_ID || task.prompt !== LEGACY_WEEKLY_PRICING_TASK_PROMPT) return null;
  return {
    prompt: WEEKLY_PRICING_TASK_PROMPT,
    ...(task.description === "Weekly LLM pricing refresh and dashboard estimate update"
      ? { description: WEEKLY_PRICING_TASK_DESCRIPTION } : {}),
  };
}