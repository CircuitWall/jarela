// In-process keyed store for background tool results and their live progress.
//
// When the wallclock wrapper sees `async_run: true` on a tool call — or moves
// a call that outlived its wall-clock budget to the background — it returns
// immediately with a key, lets the real invocation keep running, and parks
// both its output and its eventual result here. The agent follows the work
// with the `tool_result_get` / `tool_result_list` built-ins.
//
// A record therefore carries two different things with two different
// lifetimes:
//   - the outcome, which is durable (encrypted in SQLite for agent-owned
//     keys, thread-owner checked, oversized payloads spilled by reference),
//   - the progress window, which is a bounded in-memory tail plus an on-disk
//     log. Losing the window on restart costs progress only, never the
//     outcome.
//
// Memory hygiene:
//   - TTL (DEFAULT_TTL_MS) caps how long a finished result hangs around
//     unread. A background sweeper runs on a slow interval.
//   - Cap on concurrent entries (MAX_ENTRIES). When exceeded, the
//     oldest *finished* entry is evicted first; if none, the oldest
//     pending entry is dropped (with a console warn).
//   - The progress window is capped per record (PROGRESS_WINDOW_BYTES) and
//     trimmed as it grows.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "@/lib/utils/error";
import { createBackgroundResult, getBackgroundResult, listBackgroundResults, backgroundResultExists, BACKGROUND_RESULT_MAX_BYTES } from "@/lib/stores/background-results";
import { finishBackgroundOperation, withSystemSignalTransaction, type SignalPayload } from "@/lib/stores/system-signals";
import { beginThreadOperation } from "@/lib/lifecycle/system-signals";
import { getOrCreateGlobal } from "@/lib/utils/global-state";
import { getConfig } from "@/lib/env/config";
import { utf8ByteWindow } from "@/lib/utils/text";

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
  /** Bytes of live output reported while the call ran (monotonic). */
  progress_bytes: number;
  /** Bounded tail of that live output. Empty when the tool reports none. */
  progress: string;
  /** Last time the call reported output; null when it never did. */
  last_output_at: number | null;
  /** Exit code from a shell-shaped result envelope, when one was returned. */
  exit_code: number | null;
  /** Full log of the live output, when it was written to disk. */
  log_path: string | null;
  owner_thread_id?: string;
}

/** How much recent output each record keeps in memory. */
export const PROGRESS_WINDOW_BYTES = 64 * 1024;

/** Hard cap on one record's log file; output past this is dropped. */
export const PROGRESS_LOG_MAX_BYTES = 8 * 1024 * 1024;

/** How long an idle progress log survives on disk. */
export const PROGRESS_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

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
  logs: new Map<string, fs.WriteStream>(),
  sweeper: null as ReturnType<typeof setInterval> | null,
}));
const STORE = state.records;
const pendingSettlements = state.pendingSettlements;
const LOGS = state.logs;

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
    progress_bytes: 0,
    progress: "",
    last_output_at: null,
    exit_code: null,
    log_path: null,
  });
  return key;
}

function trimToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  // Binary-search the boundary so a multi-byte character is never split.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(-mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(-low);
}

function pruneProgressLogs(dir: string): void {
  const now = Date.now();
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
    const full = path.join(dir, entry.name);
    try {
      if (now - fs.statSync(full).mtimeMs > PROGRESS_LOG_RETENTION_MS) fs.unlinkSync(full);
    } catch {
      // A log being written right now, or already removed — either way the
      // next sweep looks again.
    }
  }
}

function openProgressLog(record: AsyncResultRecord): fs.WriteStream | null {
  const existing = LOGS.get(record.key);
  if (existing) return existing;
  if (!record.log_path) {
    try {
      const dir = path.join(getConfig().dataDir, "background-tasks");
      fs.mkdirSync(dir, { recursive: true });
      // Logs outlive their record's in-memory entry, so age them out here
      // rather than leaving one capped file per background call forever.
      pruneProgressLogs(dir);
      record.log_path = path.join(dir, `${record.key}.log`);
    } catch {
      // A record without a log file still has its window and durable outcome.
      return null;
    }
  }
  try {
    const stream = fs.createWriteStream(record.log_path, { flags: "a" });
    stream.on("error", () => {
      LOGS.delete(record.key);
      // Keep the in-memory window; drop only the file backstop.
      record.log_path = null;
    });
    LOGS.set(record.key, stream);
    return stream;
  } catch {
    record.log_path = null;
    return null;
  }
}

function closeProgressLog(key: string, removeFile = false): void {
  const stream = LOGS.get(key);
  if (!stream) return;
  LOGS.delete(key);
  const path = (stream as unknown as { path?: string }).path;
  try {
    stream.end(() => {
      if (!removeFile || !path) return;
      try { fs.unlinkSync(path); } catch { /* already gone */ }
    });
  } catch { /* best effort */ }
}

/**
 * Record output a running call reported. This is what turns a pending record
 * from "something is happening" into "here is what it has produced".
 */
export function appendAsyncProgress(key: string, text: string): void {
  if (!text) return;
  const record = STORE.get(key);
  if (!record || record.status !== "pending") return;
  record.progress_bytes += Buffer.byteLength(text, "utf8");
  record.progress = trimToBytes(`${record.progress}${text}`, PROGRESS_WINDOW_BYTES);
  record.last_output_at = Date.now();

  let stream: fs.WriteStream | null = LOGS.get(key) ?? null;
  if (!stream) stream = openProgressLog(record);
  if (!stream) return;
  if (stream.bytesWritten >= PROGRESS_LOG_MAX_BYTES) {
    try { stream.write("\n[output log truncated]\n"); } catch { /* best effort */ }
    closeProgressLog(key);
    record.log_path = null;
    return;
  }
  try { stream.write(text); } catch { /* best effort */ }
}

export interface AsyncProgressPage {
  text: string;
  /** Byte offset of the first returned byte in the whole stream. */
  offset: number;
  /** Cursor to pass back for the next page. */
  next_offset: number;
  total_bytes: number;
  /** Bytes that scrolled out of the window before the requested offset. */
  dropped_bytes: number;
  eof: boolean;
}

/** Read the progress window from a byte cursor. */
export function readAsyncProgress(
  key: string,
  offset = 0,
  limit = 8 * 1024,
  threadId?: string,
): AsyncProgressPage | null {
  const record = getAsyncResult(key, threadId);
  if (!record) return null;
  const bytes = Buffer.from(record.progress, "utf8");
  const windowStart = record.progress_bytes - bytes.length;
  const requested = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const start = Math.max(requested, windowStart);
  const page = utf8ByteWindow(bytes, start - windowStart, Math.max(1, Math.floor(limit)));
  const nextOffset = windowStart + page.end;
  return {
    text: bytes.subarray(page.start, page.end).toString("utf8"),
    offset: windowStart + page.start,
    next_offset: nextOffset,
    total_bytes: record.progress_bytes,
    dropped_bytes: start - requested,
    eof: nextOffset >= record.progress_bytes,
  };
}

/** Exit code from a shell-shaped result envelope, when the tool returned one. */
function exitCodeOf(result: string | null): number | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result) as { exit_code?: unknown };
    return typeof parsed.exit_code === "number" ? parsed.exit_code : null;
  } catch {
    return null;
  }
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
  record.exit_code = settlement.status === "done" ? exitCodeOf(settlement.result) : null;
  record.finished_at = Date.now();
  closeProgressLog(record.key);
}

export function retryAsyncResultSettlements(): void {
  for (const [key, settlement] of pendingSettlements) {
    if (settlement.availableAt > Date.now()) continue;
    const record = STORE.get(key);
    if (record) settleAsyncResult(record, settlement);
    else pendingSettlements.delete(key);
  }
}

/** Normalize a durable (post-restart) row into the in-memory record shape. */
function fromDurable(row: {
  key: string; owner_thread_id: string; tool: string; status: AsyncStatus;
  started_at: number; finished_at: number | null; result: string | null; error: string | null;
}): AsyncResultRecord {
  return {
    ...row,
    progress_bytes: 0,
    progress: "",
    last_output_at: null,
    exit_code: exitCodeOf(row.result),
    log_path: null,
  };
}

/** Read a record without consuming it. */
export function getAsyncResult(key: string, threadId?: string): AsyncResultRecord | null {
  const record = STORE.get(key);
  if (record?.owner_thread_id && !backgroundResultExists(key, record.owner_thread_id)) {
    STORE.delete(key);
    pendingSettlements.delete(key);
    closeProgressLog(key);
    return null;
  }
  if (record && (record.owner_thread_id ? record.owner_thread_id === threadId : threadId === undefined)) return record;
  const durable = threadId ? getBackgroundResult(key, threadId) : null;
  return durable ? fromDurable(durable) : null;
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
  const hadLog = !!rec.log_path;
  closeProgressLog(key, hadLog);
  if (hadLog) {
    try { fs.unlinkSync(rec.log_path!); } catch { /* already gone or still closing */ }
  }
  return rec;
}

/** Snapshot of all current records (newest first). For tool_result_list. */
export function listAsyncResults(threadId?: string): AsyncResultRecord[] {
  const records = new Map<string, AsyncResultRecord>();
  if (threadId) for (const record of listBackgroundResults(threadId)) records.set(record.key, fromDurable(record));
  for (const record of STORE.values()) {
    if (record.owner_thread_id && !backgroundResultExists(record.key, record.owner_thread_id)) {
      STORE.delete(record.key);
      pendingSettlements.delete(record.key);
      closeProgressLog(record.key);
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
      closeProgressLog(k);
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
  closeProgressLog(victim.key);
  if (!finished) {
    console.warn(
      `[async-results] evicted pending entry ${victim.key} (tool=${victim.tool}) ` +
      `to make room — STORE cap of ${MAX_ENTRIES} hit.`,
    );
  }
}

/** Test-only helper. */
export function __resetStore(): void {
  for (const key of [...LOGS.keys()]) closeProgressLog(key);
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
