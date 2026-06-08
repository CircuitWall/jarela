// Per-call wall-clock budgets for tools.
//
// Every registered tool is wrapped with a Promise.race against a timer
// the LLM controls via an injected `deadline_ms` schema field. When the
// timer fires first, the wrapped tool returns a structured timeout result
// to the agent instead of throwing — the turn continues, the agent gets a
// tool message saying "timed out", and can recover (retry differently,
// split the work, or move on).
//
// Why "agent self-set" instead of a global env knob: the right deadline
// is hugely context-dependent (a 5s budget for a memory_read is right;
// the same budget for `npm install` is absurd). The model knows what
// it's calling, so the model picks. The `deadline_ms` field on every
// tool's schema makes that picker explicit and self-documenting.
//
// Caveat: the underlying tool's promise is abandoned, not aborted. A
// network call or subprocess started by the tool keeps running until it
// settles into the void. Tools that own a long-lived resource (fetch,
// exec) should use the `deadline_ms` value themselves to drive their own
// abort signal — the wallclock wrapper is the backstop, not the only
// mechanism.

import { z } from "zod";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import {
  startAsyncCall,
  completeAsyncCall,
  failAsyncCall,
} from "./async-results";

const DEFAULT_DEADLINE_MS = 120_000;

// Hard ceiling so a runaway `deadline_ms` from the LLM (or a typo of
// "10 minutes" as 100_000_000) can't park a single turn for hours. The
// operator can raise or lower this with JARELA_TOOL_MAX_DEADLINE_MS
// (integer milliseconds). Anything above the ceiling is clamped and a
// warning is logged once per call.
export const DEFAULT_MAX_DEADLINE_MS = 30 * 60 * 1000;

export function getMaxDeadlineMs(): number {
  const raw = process.env.JARELA_TOOL_MAX_DEADLINE_MS;
  if (!raw) return DEFAULT_MAX_DEADLINE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_DEADLINE_MS;
}

const DEADLINE_DESCRIPTION =
  "Optional wall-clock budget for this tool call in milliseconds (default 120000, hard ceiling 1800000 / 30 min). " +
  "When the budget is exceeded the call returns a structured timeout result " +
  "and the turn continues so you can recover — pick a value that matches " +
  "the expected duration (5000-15000 for fast local ops, 30000-90000 for " +
  "network/web calls, larger for shell commands that may build or install). " +
  "Values above the ceiling are clamped; use `async_run: true` for work that genuinely needs more.";

const ASYNC_RUN_DESCRIPTION =
  "Optional. Set true to fire this tool in the background and get back a " +
  "tracking key immediately instead of waiting for the result. Use for " +
  "long-running calls (large fetches, slow shell builds) when you want to " +
  "keep the conversation moving. Retrieve the result later by calling " +
  "`tool_result_get` with the returned key. The original `deadline_ms` " +
  "still applies — it just runs in the background.";

interface WallclockedFunc {
  (args: Record<string, unknown>, config?: unknown): Promise<unknown>;
}

export function wrapWithWallclock<T extends StructuredToolInterface>(t: T): T {
  // Only zod-object schemas can be extended with `deadline_ms`. Other
  // schema shapes (raw JSON Schema, ZodString) pass through unchanged.
  // Those tools still get the wallclock race using the default budget.
  const schema = (t as unknown as { schema: unknown }).schema;
  const extendedSchema = schema instanceof z.ZodObject
    ? schema.extend({
        deadline_ms: z.number().int().positive().optional().describe(DEADLINE_DESCRIPTION),
        async_run: z.boolean().optional().describe(ASYNC_RUN_DESCRIPTION),
      })
    : null;

  const wrappedFunc: WallclockedFunc = async (args, config) => {
    const requested = readDeadlineMs(args) ?? DEFAULT_DEADLINE_MS;
    const ceiling = getMaxDeadlineMs();
    const deadlineMs = Math.min(requested, ceiling);
    if (requested > ceiling) {
      console.warn(
        `[wallclock] tool="${t.name}" requested deadline_ms=${requested} exceeds ceiling ${ceiling}; clamped. ` +
        `Use async_run: true for work that genuinely needs more, or raise JARELA_TOOL_MAX_DEADLINE_MS.`,
      );
    }
    const asyncRun = readAsyncRun(args);
    const innerArgs = stripWrapperFields(args);

    if (asyncRun) {
      return runAsync(t, innerArgs, config, deadlineMs);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<string>((resolve) => {
      timer = setTimeout(() => {
        resolve(JSON.stringify({
          ok: false,
          error_code: "tool_timeout",
          message:
            `Tool "${t.name}" exceeded its wall-clock budget of ${deadlineMs}ms. ` +
            `The call was abandoned; the underlying operation may still be running in the background. ` +
            `Recover by trying a different approach, splitting the work, or moving on — do not retry the same call with the same arguments.`,
          deadline_ms: deadlineMs,
        }));
      }, deadlineMs);
      // Don't keep the event loop alive purely for a timeout race.
      (timer as unknown as { unref?: () => void }).unref?.();
    });

    try {
      // Cast: invoke accepts a typed input matching the original schema,
      // but the wrapper is generic over all tools.
      const work = (t as unknown as { invoke: (a: unknown, c?: unknown) => Promise<unknown> }).invoke(innerArgs, config);
      return await Promise.race([work, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  // Rebuild via the public `tool()` factory so we don't depend on
  // internal field shapes of the StructuredTool class. The new tool
  // keeps the original's name and description, swaps in the extended
  // schema, and routes invocation through wrappedFunc.
  const rebuilt = tool(
    wrappedFunc as never,
    {
      name: t.name,
      description: t.description ?? "",
      schema: (extendedSchema ?? schema) as never,
    } as never,
  );
  return rebuilt as unknown as T;
}

function readDeadlineMs(args: Record<string, unknown> | unknown): number | null {
  if (!args || typeof args !== "object") return null;
  const v = (args as Record<string, unknown>).deadline_ms;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

function readAsyncRun(args: Record<string, unknown> | unknown): boolean {
  if (!args || typeof args !== "object") return false;
  return (args as Record<string, unknown>).async_run === true;
}

function stripWrapperFields(args: Record<string, unknown> | unknown): Record<string, unknown> | unknown {
  if (!args || typeof args !== "object") return args;
  const { deadline_ms: _d, async_run: _a, ...rest } = args as Record<string, unknown>;
  void _d; void _a;
  return rest;
}

/**
 * Fire the tool detached and return a pointer the agent can poll via
 * `tool_result_get`. The same `deadline_ms` still applies — when the
 * timer wins, the slot is marked errored with a timeout message.
 */
function runAsync<T extends StructuredToolInterface>(
  t: T,
  innerArgs: unknown,
  config: unknown,
  deadlineMs: number,
): string {
  const key = startAsyncCall(t.name);
  const startedAt = Date.now();

  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    failAsyncCall(
      key,
      `Tool "${t.name}" exceeded its background wall-clock budget of ${deadlineMs}ms. ` +
        "The underlying operation may still be running but its result is discarded.",
    );
  }, deadlineMs);
  (timer as unknown as { unref?: () => void }).unref?.();

  void (async () => {
    try {
      const work = (t as unknown as { invoke: (a: unknown, c?: unknown) => Promise<unknown> })
        .invoke(innerArgs, config);
      const result = await work;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      completeAsyncCall(
        key,
        typeof result === "string" ? result : JSON.stringify(result),
      );
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      failAsyncCall(key, err);
    }
  })();

  return JSON.stringify({
    ok: true,
    async: true,
    key,
    tool: t.name,
    started_at: startedAt,
    deadline_ms: deadlineMs,
    hint: `Call tool_result_get with key="${key}" to retrieve the result. Pass wait_ms to short-poll.`,
  });
}

/** Exposed for the tests. */
export const __DEFAULT_DEADLINE_MS = DEFAULT_DEADLINE_MS;
