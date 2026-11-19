// Why did this run stop?
//
// `abortRun` / `abortAllRuns` signal the run's AbortController with a reason
// string, but the agent stream only observes "the signal was aborted". Every
// consumer that labels a cancelled run — the transcript footer, the
// automation activity row, the task notification — used to assume the user
// pressed Stop. That mislabelled automatic cancellations (server restart or
// shutdown, soft reset, provider aborts) as "Interrupted by user", which is
// exactly the wrong signal for an unattended watcher/scheduled run.
//
// Anything that is not an explicit user action is a system cancellation.

export type AbortActor = "user" | "system";

export interface AbortClassification {
  actor: AbortActor;
  /** Normalized reason code; "unknown" when the controller carried none. */
  code: string;
  /** Short human phrase for the cause, safe to show in UI copy. */
  detail: string;
}

const USER_REASONS = new Set(["user_interrupted", "user_reset", "user_steer"]);

const SYSTEM_DETAILS: Record<string, string> = {
  server_shutdown: "the app shut down or restarted while the run was in flight",
  server_restart: "the app restarted while the run was in flight",
  run_idle_timeout: "the provider stream stopped making progress",
  run_watchdog_timeout: "the run exceeded its wall-clock limit",
  system_reset: "an automatic system reset stopped it",
  screen_lock: "the screen was locked",
};

const UNKNOWN_DETAIL = "the run was stopped automatically before it finished";

// Watchdogs know *why* they fired (how long the stream was silent, which
// phase the agent was in, whether any output had been produced). That context
// must survive the AbortSignal hop into the provider stream, because that is
// where the terminal error message is finally composed — and from there it
// becomes `scheduled_tasks.last_error`, the automation activity row, and the
// transcript failure reason. A bare "the provider stream stopped making
// progress" cannot be acted on; "no first token from deepseek/deepseek-v4-pro
// after 120s" can. The reason string carries an optional JSON suffix so the
// existing string contract (and every consumer that compares against the bare
// code) keeps working.
const WATCHDOG_DETAIL_SEPARATOR = "|";

const WATCHDOG_REASON_CODES = new Set(["run_idle_timeout", "run_watchdog_timeout"]);

export interface WatchdogDetail {
  /** Milliseconds the stream had been silent when the watchdog fired. */
  idleMs?: number;
  /** The configured idle ceiling that fired (JARELA_RUN_IDLE_MS). */
  idleLimitMs?: number;
  /** Milliseconds since the run started. */
  elapsedMs?: number;
  /** Registry phase at termination ("starting", "thinking", "tool", …). */
  phase?: string;
  /** False when the run had produced no text, thinking, or tool chunk yet. */
  producedOutput?: boolean;
  /** "provider/model" the run was stalled on, when the caller knows it. */
  model?: string;
}

export interface WatchdogTermination {
  code: "run_idle_timeout" | "run_max_timeout";
  message: string;
  detail: WatchdogDetail;
}

/** Encode a watchdog abort reason plus its diagnostic detail. */
export function encodeWatchdogReason(code: string, detail: WatchdogDetail = {}): string {
  const entries = Object.entries(detail).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) return code;
  return `${code}${WATCHDOG_DETAIL_SEPARATOR}${JSON.stringify(Object.fromEntries(entries))}`;
}

function parseWatchdogReason(reason: unknown): { code: string; detail: WatchdogDetail } | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf(WATCHDOG_DETAIL_SEPARATOR);
  const code = separator === -1 ? trimmed : trimmed.slice(0, separator);
  if (!WATCHDOG_REASON_CODES.has(code)) return null;
  if (separator === -1) return { code, detail: {} };
  try {
    const parsed = JSON.parse(trimmed.slice(separator + 1)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { code, detail: parsed as WatchdogDetail };
    }
  } catch {
    // Malformed detail (truncated signal reason, older build) — the bare code
    // is still authoritative.
  }
  return { code, detail: {} };
}

function describeWatchdogDetail(detail: WatchdogDetail): string {
  const parts: string[] = [];
  if (typeof detail.idleMs === "number" && detail.idleMs > 0) {
    parts.push(`${Math.round(detail.idleMs / 1000)}s of silence`);
  } else if (typeof detail.elapsedMs === "number" && detail.elapsedMs > 0) {
    parts.push(`${Math.round(detail.elapsedMs / 1000)}s elapsed`);
  }
  if (detail.producedOutput === false) parts.push("the provider never sent its first token");
  if (detail.model) parts.push(`model ${detail.model}`);
  if (detail.phase) parts.push(`phase ${detail.phase}`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

/**
 * Map a registry-watchdog abort reason to its typed terminal error. The
 * watchdogs publish this same code to subscribers, so any layer that has to
 * re-materialize the terminal chunk (retry wrappers, collectors) must use the
 * same code instead of degrading it to a generic "aborted".
 *
 * `extra` adds detail the aborting layer could not know (the model config is
 * resolved after the run registers, so only the provider stream has it).
 */
export function watchdogTermination(
  reason: unknown,
  extra: WatchdogDetail = {},
): WatchdogTermination | null {
  const parsed = parseWatchdogReason(reason);
  if (!parsed) return null;
  const detail: WatchdogDetail = { ...parsed.detail, ...Object.fromEntries(
    Object.entries(extra).filter(([, value]) => value !== undefined && value !== null),
  ) };
  const suffix = describeWatchdogDetail(detail);
  if (parsed.code === "run_idle_timeout") {
    // Name the knob that fired: the most common cause of a first-token stall
    // is a slow model on a large prompt, and the ceiling is env-tunable.
    const guidance = typeof detail.idleLimitMs === "number" && detail.idleLimitMs > 0
      ? `Retry, split the request into smaller steps, or raise JARELA_RUN_IDLE_MS ` +
        `(currently ${Math.round(detail.idleLimitMs / 1000)}s) if this model is simply slow.`
      : "Retry, or split the request into smaller steps.";
    return {
      code: "run_idle_timeout",
      message:
        `Run timed out after the provider stream stopped making progress${suffix}. ` +
        `The provider went silent before the agent finished. ${guidance}`,
      detail,
    };
  }
  return {
    code: "run_max_timeout",
    message:
      `Run timed out after reaching the wall-clock limit${suffix}. ` +
      "Try a smaller scope, or raise JARELA_RUN_MAX_MS if this is expected.",
    detail,
  };
}

/**
 * Resolve the actor/reason for an aborted run: the terminal error chunk is
 * authoritative (it carried the reason at abort time); the controller's
 * reason is the fallback when the stream was torn down without one.
 */
export function resolveAbortClassification(
  run: { abortActor?: AbortActor; abortReason?: string },
  signal?: AbortSignal,
): AbortClassification {
  const classified = classifyAbortReason(run.abortReason ?? signal?.reason);
  if (run.abortActor && run.abortActor !== classified.actor) {
    return { ...classified, actor: run.abortActor };
  }
  return classified;
}

/**
 * Classify a run-abort reason.
 *
 * - `user_interrupted` is what the Stop button's DELETE route passes, and the
 *   Settings soft reset passes a free-form string that starts with "user".
 * - Registry watchdogs pass `run_idle_timeout` / `run_watchdog_timeout`,
 *   optionally suffixed with a JSON diagnostic detail (`code|{...}`).
 * - Graceful restart/shutdown passes `server_shutdown`.
 * - A missing reason is treated as a system cancellation: an unexplained
 *   abort is not evidence that a person stopped the run.
 */
export function classifyAbortReason(reason: unknown): AbortClassification {
  const raw = typeof reason === "string" ? reason.trim() : "";
  if (!raw) {
    return { actor: "system", code: "unknown", detail: UNKNOWN_DETAIL };
  }
  // Watchdogs append a JSON diagnostic suffix to their reason code; classify
  // (and look up the human phrase) on the bare code so the detail cannot push
  // a known cause into the generic fallback.
  const bare = raw.split(WATCHDOG_DETAIL_SEPARATOR)[0];
  if (USER_REASONS.has(bare) || /^user\b/i.test(bare)) {
    return { actor: "user", code: "user_interrupted", detail: "stopped by the user" };
  }
  return {
    actor: "system",
    code: bare.length > 80 ? bare.slice(0, 80) : bare,
    detail: SYSTEM_DETAILS[bare] ?? `stopped automatically (${bare})`,
  };
}
