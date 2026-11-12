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

export interface WatchdogTermination {
  code: "run_idle_timeout" | "run_max_timeout";
  message: string;
}

/**
 * Map a registry-watchdog abort reason to its typed terminal error. The
 * watchdogs publish this same code to subscribers, so any layer that has to
 * re-materialize the terminal chunk (retry wrappers, collectors) must use the
 * same code instead of degrading it to a generic "aborted".
 */
export function watchdogTermination(reason: unknown): WatchdogTermination | null {
  if (reason === "run_idle_timeout") {
    return {
      code: "run_idle_timeout",
      message: "Run timed out after the provider stream stopped making progress.",
    };
  }
  if (reason === "run_watchdog_timeout") {
    return {
      code: "run_max_timeout",
      message: "Run timed out after reaching the wall-clock limit.",
    };
  }
  return null;
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
 * - Registry watchdogs pass `run_idle_timeout` / `run_watchdog_timeout`.
 * - Graceful restart/shutdown passes `server_shutdown`.
 * - A missing reason is treated as a system cancellation: an unexplained
 *   abort is not evidence that a person stopped the run.
 */
export function classifyAbortReason(reason: unknown): AbortClassification {
  const raw = typeof reason === "string" ? reason.trim() : "";
  if (!raw) {
    return { actor: "system", code: "unknown", detail: UNKNOWN_DETAIL };
  }
  if (USER_REASONS.has(raw) || /^user\b/i.test(raw)) {
    return { actor: "user", code: "user_interrupted", detail: "stopped by the user" };
  }
  return {
    actor: "system",
    code: raw.length > 80 ? raw.slice(0, 80) : raw,
    detail: SYSTEM_DETAILS[raw] ?? `stopped automatically (${raw})`,
  };
}
