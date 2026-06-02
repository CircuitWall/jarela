// Per-tool-invocation deadline. Wraps a tool call with a wall-clock budget
// so a hung MCP server / runaway plugin can't pin the agent loop forever
// (the run-registry watchdog is a 15-min backstop, not a per-call deadline).
//
// Behaviour:
//   - Resolves with the tool's own result if it returns before the deadline.
//   - Throws ToolTimeoutError when the deadline elapses; the run signal
//     is also aborted so any in-flight HTTP / sub-process the tool started
//     has a chance to bail out.
//   - Re-throws AbortError unchanged when the parent run was already aborted
//     (Stop button / disconnect) so callers can distinguish user cancel from
//     timeout.
//
// Caller composes `runSignal` (the agent run's AbortSignal) with the
// per-call deadline. We pass the merged signal through to the tool so a tool
// that respects AbortSignal exits cleanly — fallback for non-cooperative
// tools is the timeout itself.

export class ToolTimeoutError extends Error {
  readonly code = "tool_timeout";
  readonly toolName: string;
  readonly timeoutMs: number;
  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" exceeded ${timeoutMs}ms timeout`);
    this.name = "ToolTimeoutError";
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

export interface ToolTimeoutOptions {
  toolName: string;
  timeoutMs: number;
  runSignal?: AbortSignal;
}

/**
 * Run `task(signal)` with a wall-clock deadline. The composed signal is
 * aborted on either timeout or upstream cancellation.
 *
 * Returns the task's resolved value, throws `ToolTimeoutError` on deadline,
 * re-throws an `AbortError` on upstream cancel, or re-throws the task's own
 * error otherwise.
 */
export async function withToolTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  opts: ToolTimeoutOptions,
): Promise<T> {
  const { toolName, timeoutMs, runSignal } = opts;
  if (timeoutMs <= 0) return task(runSignal ?? new AbortController().signal);

  const ctrl = new AbortController();
  // Forward upstream abort onto the per-call controller so the task's signal
  // observes it. Skip the listener entirely when the upstream signal isn't
  // provided — saves an event handler.
  const onUpstreamAbort = () => {
    ctrl.abort(runSignal?.reason ?? "run_aborted");
  };
  if (runSignal) {
    if (runSignal.aborted) {
      ctrl.abort(runSignal.reason ?? "run_aborted");
    } else {
      runSignal.addEventListener("abort", onUpstreamAbort, { once: true });
    }
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      ctrl.abort("tool_timeout");
      reject(new ToolTimeoutError(toolName, timeoutMs));
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    return await Promise.race([task(ctrl.signal), timeoutPromise]);
  } catch (err) {
    // Race-order subtlety: when the timeout fires, ctrl.abort() runs first,
    // which causes a cooperative task to reject with its own AbortError
    // BEFORE timeoutPromise's reject lands. Promise.race then settles with
    // the task's rejection, hiding the ToolTimeoutError. Re-throw a fresh
    // one when we know the deadline fired so callers always see the same
    // error class regardless of who won the race.
    if (timedOut) throw new ToolTimeoutError(toolName, timeoutMs);
    // Distinguish upstream cancel from arbitrary tool errors. If the run
    // signal was the cause, surface AbortError so callers can branch.
    if (runSignal?.aborted) {
      const reason = runSignal.reason;
      if (err instanceof Error && err.name === "AbortError") throw err;
      const aborted = new Error(
        typeof reason === "string" ? reason : "Run aborted",
      );
      aborted.name = "AbortError";
      throw aborted;
    }
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (runSignal) runSignal.removeEventListener("abort", onUpstreamAbort);
  }
}
