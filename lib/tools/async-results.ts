// In-process keyed store for async tool results.
//
// When the wallclock wrapper sees `async_run: true` on a tool call it
// returns immediately with a key, kicks the real invocation off in the
// background, and parks the eventual result here. The agent later
// retrieves the result via the `tool_result_get` built-in.
//
// Scope is deliberately per-process, in-memory:
//   - The data lives only as long as the Next.js server process. A
//     restart wipes both the agent's in-context keys and these results
//     simultaneously, so we can't end up with the LLM holding a key
//     that survived the value.
//   - No on-disk persistence means no schema migration, no PII spill,
//     no risk of leaking long-running secrets between sessions.
//
// Memory hygiene:
//   - TTL (DEFAULT_TTL_MS) caps how long a finished result hangs around
//     unread. A background sweeper runs on a slow interval.
//   - Cap on concurrent entries (MAX_ENTRIES). When exceeded, the
//     oldest *finished* entry is evicted first; if none, the oldest
//     pending entry is dropped (with a console warn).

import crypto from "node:crypto";

export type AsyncStatus = "pending" | "done" | "error";

export interface AsyncResultRecord {
  key: string;
  tool: string;
  status: AsyncStatus;
  started_at: number;
  finished_at: number | null;
  /** Stringified tool result. Tools return JSON strings; we keep that. */
  result: string | null;
  /** Plain message when the underlying call threw. */
  error: string | null;
}

/** How long a finished result stays around if nobody reads it. */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Soft cap on total entries (pending + finished). */
export const MAX_ENTRIES = 256;

/** How often the background sweeper runs. */
const SWEEP_INTERVAL_MS = 60 * 1000;

const STORE = new Map<string, AsyncResultRecord>();

let sweeper: ReturnType<typeof setInterval> | null = null;

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    sweepExpired(DEFAULT_TTL_MS);
  }, SWEEP_INTERVAL_MS);
  (sweeper as unknown as { unref?: () => void }).unref?.();
}

/**
 * Carve out a slot for a new async tool call and return its key.
 * The key is opaque and URL-safe — the agent treats it as a token.
 */
export function startAsyncCall(tool: string): string {
  ensureSweeper();
  enforceCap();
  const key = `async_${crypto.randomBytes(8).toString("hex")}`;
  STORE.set(key, {
    key,
    tool,
    status: "pending",
    started_at: Date.now(),
    finished_at: null,
    result: null,
    error: null,
  });
  return key;
}

/** Mark a pending call as completed successfully. */
export function completeAsyncCall(key: string, result: string): void {
  const rec = STORE.get(key);
  if (!rec) return;
  rec.status = "done";
  rec.result = result;
  rec.finished_at = Date.now();
}

/** Mark a pending call as failed. */
export function failAsyncCall(key: string, err: unknown): void {
  const rec = STORE.get(key);
  if (!rec) return;
  rec.status = "error";
  rec.error = err instanceof Error ? err.message : String(err);
  rec.finished_at = Date.now();
}

/** Read a record without consuming it. */
export function getAsyncResult(key: string): AsyncResultRecord | null {
  return STORE.get(key) ?? null;
}

/** Read and immediately delete a record. */
export function consumeAsyncResult(key: string): AsyncResultRecord | null {
  const rec = STORE.get(key);
  if (!rec) return null;
  STORE.delete(key);
  return rec;
}

/** Snapshot of all current records (newest first). For tool_result_list. */
export function listAsyncResults(): AsyncResultRecord[] {
  return [...STORE.values()].sort((a, b) => b.started_at - a.started_at);
}

/**
 * Drop finished entries older than `ttlMs` (measured from `finished_at`).
 * Pending entries are never expired here — a stuck tool would otherwise
 * vanish out from under the agent.
 */
export function sweepExpired(ttlMs: number): number {
  const now = Date.now();
  let removed = 0;
  for (const [k, r] of STORE) {
    if (r.status === "pending") continue;
    if (r.finished_at == null) continue;
    if (now - r.finished_at >= ttlMs) {
      STORE.delete(k);
      removed++;
    }
  }
  return removed;
}

function enforceCap(): void {
  if (STORE.size < MAX_ENTRIES) return;
  // Prefer evicting finished entries (oldest first). Only if every entry
  // is pending do we drop a pending one.
  const sorted = [...STORE.values()].sort((a, b) => a.started_at - b.started_at);
  const finished = sorted.find((r) => r.status !== "pending");
  const victim = finished ?? sorted[0];
  if (!victim) return;
  STORE.delete(victim.key);
  if (!finished) {
    console.warn(
      `[async-results] evicted pending entry ${victim.key} (tool=${victim.tool}) ` +
      `to make room — STORE cap of ${MAX_ENTRIES} hit.`,
    );
  }
}

/** Test-only helper. */
export function __resetStore(): void {
  STORE.clear();
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

/** Test-only helper. */
export function __backdateFinished(key: string, finishedAt: number): void {
  const rec = STORE.get(key);
  if (rec) rec.finished_at = finishedAt;
}
