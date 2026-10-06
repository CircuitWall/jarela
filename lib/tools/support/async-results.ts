// In-process keyed store for async tool results.
//
// When the wallclock wrapper sees `async_run: true` on a tool call it
// returns immediately with a key, kicks the real invocation off in the
// background, and parks the eventual result here. The agent later
// retrieves the result via the `tool_result_get` built-in.
//
// The key map is a cache. Agent-owned background result envelopes are also
// encrypted in SQLite and retrieved with thread-owner checks after restart.
// Oversized payloads use the existing spill/reference API.
//
// Memory hygiene:
//   - TTL (DEFAULT_TTL_MS) caps how long a finished result hangs around
//     unread. A background sweeper runs on a slow interval.
//   - Cap on concurrent entries (MAX_ENTRIES). When exceeded, the
//     oldest *finished* entry is evicted first; if none, the oldest
//     pending entry is dropped (with a console warn).

import crypto from "node:crypto";
import { errorMessage } from "@/lib/utils/error";
import { createBackgroundResult, getBackgroundResult, listBackgroundResults, backgroundResultExists, BACKGROUND_RESULT_MAX_BYTES } from "@/lib/stores/background-results";
import { finishBackgroundOperation, withSystemSignalTransaction, type SignalPayload } from "@/lib/stores/system-signals";
import { beginThreadOperation } from "@/lib/lifecycle/system-signals";
import { getOrCreateGlobal } from "@/lib/utils/global-state";

export type AsyncStatus = "pending" | "done" | "error";

export interface AsyncResultRecord {
  key: string;
  tool: string;
  status: AsyncStatus;
  started_at: number;
  finished_at: number | null;
  /** Stringified result or result-ref envelope. */
  result: string | null;
  /** Plain message when the underlying call threw. */
  error: string | null;
  owner_thread_id?: string;
}

/** How long a finished result stays around if nobody reads it. */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Soft cap on total entries (pending + finished). */
export const MAX_ENTRIES = 256;

/** How often the background sweeper runs. */
const SWEEP_INTERVAL_MS = 60 * 1000;

interface PendingSettlement {
  status: "done" | "error";
  result: string | null;
  error: string | null;
  kind: "background_tool.completed" | "background_tool.failed" | "background_tool.timed_out";
  attempts: number;
  availableAt: number;
}
const state = getOrCreateGlobal("__jarela_async_result_state", () => ({
  records: new Map<string, AsyncResultRecord>(),
  pendingSettlements: new Map<string, PendingSettlement>(),
  sweeper: null as ReturnType<typeof setInterval> | null,
}));
const STORE = state.records;
const pendingSettlements = state.pendingSettlements;

function ensureSweeper(): void {
  if (state.sweeper) return;
  state.sweeper = setInterval(() => {
    retryAsyncResultSettlements();
    sweepExpired(DEFAULT_TTL_MS);
  }, SWEEP_INTERVAL_MS);
  (state.sweeper as unknown as { unref?: () => void }).unref?.();
}

/**
 * Tear down the sweeper. Called from the shutdown drain so the timer
 * isn't keeping the event loop alive past close-time. Idempotent.
 */
export function stopAsyncResults(): void {
  if (state.sweeper) {
    clearInterval(state.sweeper);
    state.sweeper = null;
  }
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

export function startOwnedAsyncCall(tool: string, threadId: unknown, signalContinuation = false, extraPayload: SignalPayload = {}): { key: string; owned: boolean } {
  const key = startAsyncCall(tool);
  if (typeof threadId !== "string") return { key, owned: false };
  let owned = false;
  try {
    withSystemSignalTransaction(() => {
      const operationId = beginThreadOperation(threadId, "background_tool", key, { ...extraPayload, tool, wake_eligible: !signalContinuation });
      if (operationId && typeof threadId === "string") {
        attachAsyncResultOwner(key, threadId);
        owned = true;
      }
    });
    return { key, owned };
  } catch (error) {
    STORE.delete(key);
    throw error;
  }
}

/** Mark a pending call as completed successfully. */
export function completeAsyncCall(key: string, result: string): void {
  const rec = STORE.get(key);
  if (!rec) return;
  settleAsyncResult(rec, { status: "done", result, error: null, kind: "background_tool.completed", attempts: 0, availableAt: Date.now() });
}

/** Mark a pending call as failed. */
export function failAsyncCall(key: string, err: unknown, kind: PendingSettlement["kind"] = "background_tool.failed"): void {
  const rec = STORE.get(key);
  if (!rec) return;
  settleAsyncResult(rec, { status: "error", result: null, error: errorMessage(err), kind, attempts: 0, availableAt: Date.now() });
}

function settleAsyncResult(record: AsyncResultRecord, settlement: PendingSettlement): void {
  if (record.owner_thread_id) {
    if (Buffer.byteLength(JSON.stringify({ result: settlement.result, error: settlement.error })) > BACKGROUND_RESULT_MAX_BYTES) {
      settlement = { ...settlement, status: "error", result: null,
        error: "Background output exceeded its durable storage budget. The operation may have completed; verify external effects before retrying.",
        kind: "background_tool.failed" };
    }
    try { finishBackgroundOperation(record.key, settlement.status, settlement.result, settlement.error, settlement.kind); }
    catch {
      settlement.attempts++;
      if (settlement.attempts < 5) {
        settlement.availableAt = Date.now() + Math.min(60_000, 1000 * 2 ** settlement.attempts);
        pendingSettlements.set(record.key, settlement);
        console.warn("[async-results] outcome settlement deferred", { key: record.key, attempt: settlement.attempts });
        return;
      }
      record.status = "error";
      record.error = "Background outcome persistence failed repeatedly. The external outcome may be unknown; do not automatically repeat the operation.";
      record.finished_at = Date.now();
      pendingSettlements.delete(record.key);
      console.error("[async-results] outcome settlement exhausted", { key: record.key });
      return;
    }
  }
  pendingSettlements.delete(record.key);
  record.status = settlement.status;
  record.result = settlement.result;
  record.error = settlement.error;
  record.finished_at = Date.now();
}

export function retryAsyncResultSettlements(): void {
  for (const [key, settlement] of pendingSettlements) {
    if (settlement.availableAt > Date.now()) continue;
    const record = STORE.get(key);
    if (record) settleAsyncResult(record, settlement);
    else pendingSettlements.delete(key);
  }
}

/** Read a record without consuming it. */
export function getAsyncResult(key: string, threadId?: string): AsyncResultRecord | null {
  const record = STORE.get(key);
  if (record?.owner_thread_id && !backgroundResultExists(key, record.owner_thread_id)) {
    STORE.delete(key);
    pendingSettlements.delete(key);
    return null;
  }
  if (record && (record.owner_thread_id ? record.owner_thread_id === threadId : threadId === undefined)) return record;
  return threadId ? getBackgroundResult(key, threadId) : null;
}

export function attachAsyncResultOwner(key: string, threadId: string): void {
  const record = STORE.get(key);
  if (!record) throw new Error("Unknown background result key");
  createBackgroundResult(key, threadId, record.tool);
  record.owner_thread_id = threadId;
}

/** Read and immediately delete a record. */
export function consumeAsyncResult(key: string, threadId?: string): AsyncResultRecord | null {
  const rec = getAsyncResult(key, threadId);
  if (!rec) return null;
  if (threadId) getBackgroundResult(key, threadId, true);
  STORE.delete(key);
  return rec;
}

/** Snapshot of all current records (newest first). For tool_result_list. */
export function listAsyncResults(threadId?: string): AsyncResultRecord[] {
  const records = new Map<string, AsyncResultRecord>();
  if (threadId) for (const record of listBackgroundResults(threadId)) records.set(record.key, record);
  for (const record of STORE.values()) {
    if (record.owner_thread_id && !backgroundResultExists(record.key, record.owner_thread_id)) {
      STORE.delete(record.key);
      pendingSettlements.delete(record.key);
      continue;
    }
    if (record.owner_thread_id ? record.owner_thread_id === threadId : threadId === undefined) records.set(record.key, record);
  }
  return [...records.values()].sort((left, right) => right.started_at - left.started_at);
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
  const victim = finished ?? sorted.find((record) => !record.owner_thread_id);
  if (!victim) throw new Error("Background tool capacity reached; wait for an active call to finish");
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
  pendingSettlements.clear();
  if (state.sweeper) {
    clearInterval(state.sweeper);
    state.sweeper = null;
  }
}

/** Test-only helper. */
export function __backdateFinished(key: string, finishedAt: number): void {
  const rec = STORE.get(key);
  if (rec) rec.finished_at = finishedAt;
}
