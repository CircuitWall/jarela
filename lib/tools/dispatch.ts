// Central tool dispatch — single chokepoint for executing a tool with
// observability + result normalization. Ties together the per-call timeout
// (PR-1's withToolTimeout), structured logging, and a unified ToolResult
// shape so downstream consumers don't have to interpret each tool's
// idiosyncratic return.
//
// Today this module is opted-into by `executeTool` in lib/tools/index.ts;
// the LangGraph agent loop still invokes tools directly through their
// StructuredTool wrappers (which carry their own LangChain-side argument
// validation). A follow-up can wire dispatch into `registerTools` so every
// tool invocation — including the agent loop's — goes through here.
//
// See ADR-0047.

import type { ToolResult } from "./types";

export interface DispatchOptions {
  /** Tool name — appears in structured logs. */
  toolName: string;
  /**
   * Optional thread/run identifiers — written to the dispatch log for
   * debugging "what happened in this turn". Omitted entries become
   * "—" in the log line.
   */
  threadId?: string;
  runId?: string;
}

export interface DispatchLogEntry {
  toolName: string;
  threadId: string | null;
  runId: string | null;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  status: "ok" | "error" | "timeout";
  errorMessage?: string;
  errorCode?: string;
}

// Lightweight in-memory ring buffer of recent dispatches. The chat UI / a
// future debug surface can render this without a DB write per call. Capped
// to keep memory bounded when long tasks emit many tool calls.
const RING_CAPACITY = 500;
const ring: DispatchLogEntry[] = [];

export function recentDispatchLog(limit?: number): DispatchLogEntry[] {
  if (!limit || limit >= ring.length) return ring.slice();
  return ring.slice(-limit);
}

function logDispatch(entry: DispatchLogEntry): void {
  ring.push(entry);
  if (ring.length > RING_CAPACITY) {
    ring.splice(0, ring.length - RING_CAPACITY);
  }
  // Console form is grep-friendly: prefix + key=value pairs. Picks up in
  // any log aggregator without schema discovery.
  const tail = entry.status === "ok"
    ? `dur=${entry.durationMs}ms`
    : `dur=${entry.durationMs}ms code=${entry.errorCode ?? "unknown"} msg=${entry.errorMessage?.slice(0, 200) ?? ""}`;
  console.info(
    `[tool-dispatch] tool=${entry.toolName} thread=${entry.threadId ?? "-"} run=${entry.runId ?? "-"} status=${entry.status} ${tail}`,
  );
}

/**
 * Coerce a raw tool return into the ToolResult union. Mirrors the prior
 * "JSON.parse-or-fall-back-to-string" heuristic from `executeTool`, but
 * makes the kind explicit at the boundary instead of leaving downstream
 * consumers to detect it.
 *
 *  - `{kind, ...}` already-shaped values pass through (kind validated).
 *  - Strings starting with `{` or `[` parse as JSON when possible; else text.
 *  - Plain objects/arrays/numbers/booleans wrap as `{kind:"json"}`.
 *  - `undefined`/`null` become `{kind:"json", data: null}` rather than text
 *    so consumers don't have to special-case empty responses.
 */
export function normalizeToolResult(raw: unknown): ToolResult {
  if (raw === undefined || raw === null) return { kind: "json", data: null };
  if (typeof raw === "object" && raw !== null && "kind" in raw) {
    const o = raw as { kind?: unknown };
    if (o.kind === "json" || o.kind === "text" || o.kind === "error") {
      return raw as ToolResult;
    }
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return { kind: "json", data: JSON.parse(trimmed) };
      } catch {
        return { kind: "text", data: raw };
      }
    }
    return { kind: "text", data: raw };
  }
  return { kind: "json", data: raw };
}

/**
 * Run a tool invocation through the central dispatch chokepoint. Wraps the
 * caller's `runFn` with timing + structured logging, normalises the result
 * (or thrown error) into a ToolResult. Does NOT own the per-call timeout —
 * caller stacks `withToolTimeout` outside this when needed (see executeTool).
 *
 * Throws ONLY when the caller explicitly opts out of error normalization
 * via `rethrow: true`. The default behaviour catches the throw, logs it,
 * and returns `{kind: "error", code: "tool_threw", message}` so the agent
 * loop can keep going.
 */
export async function runToolDispatched(
  runFn: () => Promise<unknown>,
  opts: DispatchOptions & { rethrow?: boolean },
): Promise<ToolResult> {
  const startedAt = Date.now();
  try {
    const raw = await runFn();
    const result = normalizeToolResult(raw);
    const endedAt = Date.now();
    logDispatch({
      toolName: opts.toolName,
      threadId: opts.threadId ?? null,
      runId: opts.runId ?? null,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      status: result.kind === "error" ? "error" : "ok",
      errorMessage: result.kind === "error" ? result.message : undefined,
      errorCode: result.kind === "error" ? result.code : undefined,
    });
    return result;
  } catch (err) {
    const endedAt = Date.now();
    const message = err instanceof Error ? err.message : String(err);
    // Distinguish timeout from generic throw via duck-typed `code`. Avoids
    // an import cycle into ./timeout.
    const code = err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "tool_threw";
    logDispatch({
      toolName: opts.toolName,
      threadId: opts.threadId ?? null,
      runId: opts.runId ?? null,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      status: code === "tool_timeout" ? "timeout" : "error",
      errorMessage: message,
      errorCode: code,
    });
    if (opts.rethrow) throw err;
    return { kind: "error", message, code };
  }
}

/** Test-only: drop accumulated dispatch entries between cases. */
export function _resetDispatchLog(): void {
  ring.length = 0;
}
