// Per-call wall-clock budgets and result envelopes for tools.
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
//
// Oversized successful results spill after the race resolves, so local
// serialization/hash/write time can extend elapsed time past deadline_ms.

import { z } from "zod";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import {
  startAsyncCall,
  completeAsyncCall,
  failAsyncCall,
} from "./async-results";
import { getStreamDefault } from "./tool-metadata";
import { postProcessToolResult } from "./result-refs";

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

const STREAM_DESCRIPTION =
  "Optional. Controls whether this call's incremental progress (only " +
  "tools that report progress internally, e.g. claude_delegate, do this) " +
  "reaches the UI live as it runs. Omit this to use the tool's own " +
  "default. Set true to force a live trace for this call even on a tool " +
  "that's normally quiet, or false to silence one that normally streams " +
  "(e.g. a claude_delegate call whose intermediate steps you don't want " +
  "surfaced to the user this time).";

interface WallclockedFunc {
  (args: Record<string, unknown>, config?: unknown): Promise<unknown>;
}

interface ConfigWithWriter {
  writer?: (chunk: unknown) => void;
  [k: string]: unknown;
}

/**
 * Wrap `config.writer` (LangGraph's custom-stream channel, see
 * reportToolProgress in lib/tools/workspace-context.ts) so that any call a
 * tool makes to report progress also resets an activity timer, before
 * forwarding the chunk to the caller's own writer unchanged. This is the
 * generic hook that lets ANY tool's wall-clock budget become idle-based
 * ("reset on activity") just by adopting reportToolProgress — the wrapper
 * doesn't know or care which tool is doing it. See ADR-0073.
 */
function withActivityReset(config: unknown, onActivity: () => void, forward: boolean): unknown {
  const c = config as ConfigWithWriter | undefined;
  const originalWriter = c?.writer;
  return {
    ...(c ?? {}),
    writer: (chunk: unknown) => {
      // Activity always resets the idle timer, even when streaming is off
      // for this call — "don't show it live" shouldn't also mean "treat
      // the tool as stalled".
      onActivity();
      if (forward) originalWriter?.(chunk);
    },
  };
}

interface JsonObjectSchema {
  type?: string;
  properties?: Record<string, unknown>;
  [k: string]: unknown;
}

// A JSON-Schema tool (external .cjs tools, MCP tools) is "object-shaped"
// when it declares `type: "object"`, or omits `type` but already has a
// `properties` map (some MCP servers drop the redundant `type`). Anything
// else (arrays, primitives, `false`/`true` boolean schemas) isn't a shape
// we can merge properties into.
function isJsonObjectSchema(schema: unknown): schema is JsonObjectSchema {
  if (!schema || typeof schema !== "object") return false;
  const s = schema as JsonObjectSchema;
  if (s.type === "object") return true;
  return s.type === undefined && typeof s.properties === "object" && s.properties !== null;
}

// Merge the three wrapper properties into an existing JSON Schema object.
// Deliberately does not touch `required` (all three are optional) or
// `additionalProperties` — adding the keys to `properties` is enough for
// `additionalProperties: false` to keep admitting them while still
// rejecting genuinely unknown properties.
function extendJsonObjectSchema(schema: JsonObjectSchema): JsonObjectSchema {
  return {
    ...schema,
    properties: {
      ...(schema.properties ?? {}),
      deadline_ms: { type: "number", description: DEADLINE_DESCRIPTION },
      async_run: { type: "boolean", description: ASYNC_RUN_DESCRIPTION },
      stream: { type: "boolean", description: STREAM_DESCRIPTION },
    },
  };
}

export function wrapWithWallclock<T extends StructuredToolInterface>(t: T): T {
  // Zod-object schemas (every built-in tool) get `.extend()`. Plain
  // JSON-Schema object schemas (every external .cjs tool, every MCP
  // tool — neither speaks Zod) get the same three properties merged in
  // by hand. Anything else (ZodString, a JSON schema that isn't an
  // object type, …) passes through unchanged — those tools still get the
  // wallclock race, just with the silent default budget, since there's
  // no schema shape to advertise deadline_ms/async_run/stream through.
  const schema = (t as unknown as { schema: unknown }).schema;
  let extendedSchema: unknown = null;
  if (schema instanceof z.ZodObject) {
    extendedSchema = schema.extend({
      deadline_ms: z.number().int().positive().optional().describe(DEADLINE_DESCRIPTION),
      async_run: z.boolean().optional().describe(ASYNC_RUN_DESCRIPTION),
      stream: z.boolean().optional().describe(STREAM_DESCRIPTION),
    });
  } else if (isJsonObjectSchema(schema)) {
    extendedSchema = extendJsonObjectSchema(schema);
  }

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
    const streamOn = readStream(args) ?? getStreamDefault(t);
    const innerArgs = stripWrapperFields(args);

    if (asyncRun) {
      return runAsync(t, innerArgs, config, deadlineMs, streamOn);
    }

    let timer!: ReturnType<typeof setTimeout>;
    let resolveTimeout!: (v: string) => void;
    const timeoutPromise = new Promise<string>((resolve) => { resolveTimeout = resolve; });
    const armTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        resolveTimeout(JSON.stringify({
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
    };
    armTimer();
    // Any config.writer() call from inside the tool (reportToolProgress)
    // proves it's still active — reset the budget instead of abandoning it.
    const configForInner = withActivityReset(config, armTimer, streamOn);

    try {
      // Cast: invoke accepts a typed input matching the original schema,
      // but the wrapper is generic over all tools.
      const work = (t as unknown as { invoke: (a: unknown, c?: unknown) => Promise<unknown> }).invoke(innerArgs, configForInner);
      const result = await Promise.race([work, timeoutPromise]);
      return postProcessToolResult(t.name, result);
    } finally {
      clearTimeout(timer);
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

// null means "not specified by the caller" so wrappedFunc can fall back
// to the tool's own default.
function readStream(args: Record<string, unknown> | unknown): boolean | null {
  if (!args || typeof args !== "object") return null;
  const v = (args as Record<string, unknown>).stream;
  return typeof v === "boolean" ? v : null;
}

function stripWrapperFields(args: Record<string, unknown> | unknown): Record<string, unknown> | unknown {
  if (!args || typeof args !== "object") return args;
  const { deadline_ms: _d, async_run: _a, stream: _s, ...rest } = args as Record<string, unknown>;
  void _d; void _a; void _s;
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
  streamOn: boolean,
): string {
  const key = startAsyncCall(t.name);
  const startedAt = Date.now();

  let settled = false;
  let timer!: ReturnType<typeof setTimeout>;
  const armTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      failAsyncCall(
        key,
        `Tool "${t.name}" exceeded its background wall-clock budget of ${deadlineMs}ms. ` +
          "The underlying operation may still be running but its result is discarded.",
      );
    }, deadlineMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  };
  armTimer();
  // Same idle-reset hook as the sync path — a config.writer() call from
  // inside the tool (reportToolProgress) proves it's still active.
  const configForInner = withActivityReset(config, armTimer, streamOn);

  void (async () => {
    try {
      const work = (t as unknown as { invoke: (a: unknown, c?: unknown) => Promise<unknown> })
        .invoke(innerArgs, configForInner);
      const result = await work;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      completeAsyncCall(key, await postProcessToolResult(t.name, result));
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
