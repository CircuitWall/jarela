// ADR-0025. Trigger abstraction.
//
// A "trigger" is anything that fires an agent autonomously. The original
// in-tree implementation was the scheduled-task cron loop, with its
// firing logic baked directly into lib/scheduler/index.ts. PR-B extracts
// that into a generic shape so future trigger kinds (tool_call in PR-C,
// fs_watch in PR-D) plug in without rewriting the scheduler.

/**
 * A single, ready-to-run firing of a trigger. Whatever produced it has
 * already decided that the agent should be invoked now; the runner
 * does NOT re-check schedule / debounce / dedupe.
 */
export interface TriggerFiring {
  /** Opaque id of the underlying trigger row. The handler owns its meaning. */
  id: string;
  /** Handler kind that produced this firing, e.g. "scheduled_task". */
  kind: string;
  /** Agent to invoke. */
  agentId: string;
  /** Prompt content as the user-turn message that opens this firing. */
  prompt: string;
  /**
   * When true the runner wraps the prompt with the "reply only if material"
   * directive + NO_REPLY sentinel and drops the assistant turn if the model
   * returns NO_REPLY or an empty body. Matches the existing scheduled-task
   * silent mode (ADR-0022).
   */
  silent?: boolean;
  /**
   * userCategory tag attached to both the user and assistant messages so the
   * chat-panel filter toolbar can group / hide firings. Defaults to the
   * handler kind when omitted.
   */
  category?: string;
  /** Free-form bag the handler can read back in markFired(). */
  meta?: Record<string, unknown>;
}

export interface TriggerOutcome {
  /** done = assistant turn persisted; skipped = NO_REPLY or empty; error = run threw. */
  status: "done" | "skipped" | "error";
  /** Short preview of the assistant content (for notifications). Empty when skipped/error. */
  preview: string;
  /** Thread id used for the run. Empty string when the run failed before a thread was opened. */
  threadId: string;
  /** Error message when status === "error". */
  error?: string;
}

export interface TriggerHandler {
  /** Identifies the handler; matches TriggerFiring.kind that this handler produces. */
  kind: string;
  /**
   * Triggers due to fire as of the given instant. Called once per scheduler
   * tick. Handlers may return synchronously or asynchronously; the scheduler
   * awaits the result.
   */
  getDueFirings(asOf: Date): TriggerFiring[] | Promise<TriggerFiring[]>;
  /**
   * Bookkeeping after a firing completes (or fails). Handlers update their
   * own state here — recomputing next_run_at, clearing a pending flag,
   * publishing notifications, etc.
   */
  markFired(firing: TriggerFiring, outcome: TriggerOutcome): void | Promise<void>;
}
