// ADR-0025 / ADR-0028. Trigger abstraction.
//
// A "trigger" is anything that fires autonomously. The original in-tree
// implementation was the scheduled-task cron loop, with its firing logic
// baked directly into lib/scheduler/index.ts. PR-B extracted that into
// a generic shape so future trigger kinds plug in without rewriting the
// scheduler. PR-D (this file's current shape) generalises a firing
// further into a `mode: "prompt" | "script"` discriminated union so
// non-chat work (file re-index, remote sweep) can ride the same pipe.

/** Common shape every firing carries regardless of mode. */
interface TriggerFiringBase {
  /** Opaque id of the underlying trigger row. The handler owns its meaning. */
  id: string;
  /** Handler kind that produced this firing, e.g. "scheduled_task", "fs_watch". */
  kind: string;
  /** Free-form bag the handler can read back in markFired(). */
  meta?: Record<string, unknown>;
}

/**
 * A firing that opens a thread and runs an agent prompt. The runner
 * persists user + assistant messages and respects silent-mode
 * NO_REPLY suppression (ADR-0022).
 */
export interface PromptFiring extends TriggerFiringBase {
  mode: "prompt";
  /** Agent to invoke. */
  agentId: string;
  /** Prompt content as the user-turn message that opens this firing. */
  prompt: string;
  /**
   * When true the runner wraps the prompt with the "reply only if material"
   * directive + NO_REPLY sentinel and drops the assistant turn if the model
   * returns NO_REPLY or an empty body.
   */
  silent?: boolean;
  /**
   * userCategory tag attached to both the user and assistant messages so the
   * chat-panel filter toolbar can group / hide firings. Defaults to the
   * handler kind when omitted.
   */
  category?: string;
}

/**
 * A firing that runs an in-process script — no thread, no LLM, no
 * persisted messages. The script does its own side effects (e.g.
 * upserts a document row) and returns a short preview for telemetry.
 * The script name is a key into the in-process script registry; only
 * built-ins ship — no eval, no shell-out (ADR-0028).
 */
export interface ScriptFiring extends TriggerFiringBase {
  mode: "script";
  /** Registry key, e.g. "documents.reindex_local_file". */
  script: string;
  /** Argument bag passed straight to the script function. */
  args?: Record<string, unknown>;
}

export type TriggerFiring = PromptFiring | ScriptFiring;

export interface TriggerOutcome {
  /** done = run completed; skipped = NO_REPLY or empty (prompt only); error = run threw. */
  status: "done" | "skipped" | "error";
  /** Short preview of the result (assistant content for prompt, script-supplied for script). */
  preview: string;
  /** Thread id used for the run. Empty string for script firings or when the run failed before a thread was opened. */
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
  /**
   * Optional: invoked once at process boot. Use for attaching watchers,
   * reading source rows, etc. Idempotent — may be called again after
   * source-list changes.
   */
  start?(): void | Promise<void>;
  /**
   * Optional: invoked on graceful shutdown. Use for closing watchers /
   * draining timers.
   */
  stop?(): void | Promise<void>;
  /**
   * Optional: invoked when something the handler cares about changed
   * (e.g. document_sources mutated). Lets watchers re-sync without a
   * full restart.
   */
  sync?(): void | Promise<void>;
}
