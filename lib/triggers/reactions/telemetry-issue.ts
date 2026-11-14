// ADR-0031 / ADR-0032 — `reaction.telemetry_issue`: run the tool-telemetry
// threshold check with no LLM round-trip.
//
// Replaces the model-driven "Telemetry threshold check" scheduled prompt.
// That prompt re-implemented logic that already lives in
// `maybeAutoFileToolTelemetryIssue` — same +500 failure-pattern threshold,
// same bucket/fingerprint dedupe, same GitHub filing — but paid for a full
// agent turn per firing and could be killed by the idle watchdog when the
// provider stream stalled. A script firing is deterministic and cheap.
//
// Args provided by the scheduled-task handler at fire time:
//   { task: { id, agent_id, description, schedule, schedule_kind } }
// User-supplied args (the subset this script reads):
//   { failure_threshold?: number, min_failure_count?: number }
import { registerScript, type ScriptResult } from "@/lib/triggers/scripts";
import {
  currentToolFailureMetric,
  maybeAutoFileToolTelemetryIssue,
} from "@/lib/tools/system/tool-telemetry-issue";
import { errorMessage } from "@/lib/utils/error";

const DEFAULT_FAILURE_THRESHOLD = 500;
const DEFAULT_MIN_FAILURE_COUNT = 2;

function readPositiveIntArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const raw = args[key];
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

export function formatTelemetryOutcome(
  result: Awaited<ReturnType<typeof maybeAutoFileToolTelemetryIssue>>,
  threshold: number,
): string {
  const patterns = result.metric?.value ?? currentToolFailureMetric(threshold).value;
  const counts = `${patterns} failure pattern${patterns === 1 ? "" : "s"}, threshold ${threshold}`;
  if (result.github?.ok) {
    const label = result.github.number === null ? "filed issue (number unavailable)" : `filed issue #${result.github.number}`;
    return `telemetry: ${label} — ${counts}`.slice(0, 200);
  }
  const reason = result.reason ?? (result.skipped ? "skipped" : "not_filed");
  const hint = reason === "github_token_missing"
    ? " — set GITHUB_TOKEN or GH_TOKEN for the Jarela server"
    : "";
  return `telemetry: no issue filed — ${reason} (${counts})${hint}`.slice(0, 240);
}

registerScript("reaction.telemetry_issue", async (args: Record<string, unknown>): Promise<ScriptResult> => {
  const threshold = readPositiveIntArg(args, "failure_threshold", DEFAULT_FAILURE_THRESHOLD);
  const minFailureCount = readPositiveIntArg(args, "min_failure_count", DEFAULT_MIN_FAILURE_COUNT);
  let result: Awaited<ReturnType<typeof maybeAutoFileToolTelemetryIssue>>;
  try {
    result = await maybeAutoFileToolTelemetryIssue(new Date(), {
      failureThreshold: threshold,
      minFailureCount,
    });
  } catch (err) {
    // The check itself threw (store/DB error). Rethrow so the firing is
    // recorded as failed instead of silently reporting "all clear".
    throw new Error(`telemetry threshold check failed: ${errorMessage(err)}`);
  }
  if (result.github && !result.github.ok) {
    throw new Error(`telemetry issue filing failed: ${result.github.error}`);
  }
  return { preview: formatTelemetryOutcome(result, threshold) };
});
