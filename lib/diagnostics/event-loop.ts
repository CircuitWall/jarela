// Event-loop starvation diagnostics.
//
// node:sqlite is synchronous and several hot paths (document search, local
// embedding inference) do their work on the main thread, so a single call can
// freeze every HTTP handler, stream and timer at once — the app appears to
// stop the world, then recovers. Without a log line naming the operation, the
// only symptom is that requests time out, which is what makes these stalls so
// hard to pin down.
//
// Two halves:
//   1. `withBlockingWork(label, fn)` marks a synchronous region so the
//      watchdog can report which one was running when the loop stalled.
//   2. `startEventLoopWatchdog()` samples actual loop delay and logs a
//      warning naming that region plus the slowest recent SQL statements.
//
// Everything is cheap on the happy path: a push/pop per labelled region, two
// performance.now() calls, and one histogram read per sample interval.

import { monitorEventLoopDelay } from "node:perf_hooks";
import { getOrCreateGlobal } from "@/lib/utils/global-state";

const DEFAULT_STALL_MS = 1_000;
const DEFAULT_SAMPLE_MS = 10_000;
const SLOW_WORK_MS = 250;
const MAX_RECENT_STATEMENTS = 5;
const MAX_SQL_CHARS = 200;

interface BlockingRegion {
  label: string;
  started_at: number;
}

interface SlowStatement {
  sql: string;
  ms: number;
  rows: number | null;
  at: string;
}

interface DiagnosticsState {
  started: boolean;
  timer: NodeJS.Timeout | null;
  regions: BlockingRegion[];
  slow_work: Array<{ label: string; ms: number; at: string }>;
  slow_statements: SlowStatement[];
  stall_count: number;
}

function state(): DiagnosticsState {
  return getOrCreateGlobal<DiagnosticsState>("__jarela_blocking_work", () => ({
    started: false,
    timer: null,
    regions: [],
    slow_work: [],
    slow_statements: [],
    stall_count: 0,
  }));
}

function pushBounded<T>(list: T[], entry: T, max: number): void {
  list.push(entry);
  if (list.length > max) list.splice(0, list.length - max);
}

/**
 * Marks a synchronous region that can block the event loop. The label is
 * reported by the watchdog while the region is still running, so a stall that
 * never returns is still attributed.
 */
export function withBlockingWork<Result>(label: string, work: () => Result): Result {
  const s = state();
  const region: BlockingRegion = { label, started_at: performance.now() };
  s.regions.push(region);
  try {
    return work();
  } finally {
    const ms = performance.now() - region.started_at;
    const index = s.regions.lastIndexOf(region);
    if (index >= 0) s.regions.splice(index, 1);
    if (ms >= SLOW_WORK_MS) {
      pushBounded(s.slow_work, { label, ms: Math.round(ms), at: new Date().toISOString() }, MAX_RECENT_STATEMENTS);
      console.warn(`[event-loop] slow sync region ${Math.round(ms)}ms: ${label}`);
    }
  }
}

/** Innermost labelled region, or null when the stall happened elsewhere. */
export function currentBlockingWork(): string | null {
  const s = state();
  return s.regions.length > 0 ? s.regions[s.regions.length - 1].label : null;
}

/**
 * Async variant for CPU work that runs in-process behind an `await` — the
 * local ONNX embedding pipeline is the case this exists for. The label stays
 * active while the promise is pending, so a stall reported here can also mean
 * the loop was idle waiting on I/O; the slow-statement lines distinguish the
 * two.
 */
export async function withBlockingWorkAsync<Result>(label: string, work: () => Promise<Result>): Promise<Result> {
  const s = state();
  const region: BlockingRegion = { label, started_at: performance.now() };
  s.regions.push(region);
  try {
    return await work();
  } finally {
    const ms = performance.now() - region.started_at;
    const index = s.regions.lastIndexOf(region);
    if (index >= 0) s.regions.splice(index, 1);
    if (ms >= SLOW_WORK_MS) {
      pushBounded(s.slow_work, { label, ms: Math.round(ms), at: new Date().toISOString() }, MAX_RECENT_STATEMENTS);
    }
  }
}

/**
 * Records a statement that took a long time inside node:sqlite. Called by the
 * database timing wrapper; also keeps the statement available as context for
 * the next watchdog report.
 */
export function noteSlowStatement(sql: string, ms: number, rows: number | null): void {
  const s = state();
  const flattened = sql.replace(/\s+/g, " ").trim();
  const entry: SlowStatement = {
    sql: flattened.length > MAX_SQL_CHARS ? `${flattened.slice(0, MAX_SQL_CHARS - 1)}…` : flattened,
    ms: Math.round(ms),
    rows,
    at: new Date().toISOString(),
  };
  pushBounded(s.slow_statements, entry, MAX_RECENT_STATEMENTS);
  const rowText = rows === null ? "" : ` rows=${rows}`;
  console.warn(`[db] slow statement ${entry.ms}ms${rowText}: ${entry.sql}`);
}

export interface EventLoopWatchdogOptions {
  /** Report a stall at or above this delay (ms). 0 disables the watchdog. */
  stallMs?: number;
  /** How often the histogram is read, in ms. */
  sampleMs?: number;
}

export interface EventLoopSample {
  maxMs: number;
  meanMs: number;
  p99Ms: number;
  stallMs: number;
  currentWork: string | null;
  slowWork: readonly { label: string; ms: number; at: string }[];
  slowStatements: readonly SlowStatement[];
}

/** Pure formatter so the report shape is testable without a real stall. */
export function formatStallReport(sample: EventLoopSample): string {
  const active = sample.currentWork ? ` while running "${sample.currentWork}"` : "";
  const lines = [
    `[event-loop] blocked for ${Math.round(sample.maxMs)}ms (mean ${Math.round(sample.meanMs)}ms, p99 ${Math.round(sample.p99Ms)}ms, threshold ${Math.round(sample.stallMs)}ms)${active}`,
  ];
  if (!sample.currentWork) {
    const recent = sample.slowWork[sample.slowWork.length - 1];
    if (recent) lines.push(`  last slow sync region: ${recent.label} ${recent.ms}ms at ${recent.at}`);
  }
  for (const statement of sample.slowStatements) {
    const rowText = statement.rows === null ? "" : ` rows=${statement.rows}`;
    lines.push(`  slow statement ${statement.ms}ms${rowText}: ${statement.sql}`);
  }
  return lines.join("\n");
}

function readSample(stallMs: number, histogram: { max: number; mean: number; percentile(p: number): number }): EventLoopSample {
  const s = state();
  return {
    maxMs: histogram.max / 1e6,
    meanMs: histogram.mean / 1e6,
    p99Ms: histogram.percentile(99) / 1e6,
    stallMs,
    currentWork: currentBlockingWork(),
    slowWork: [...s.slow_work],
    slowStatements: [...s.slow_statements],
  };
}

/**
 * Starts the watchdog once per process. Returns a stop function (used by
 * tests). Safe to call from hot-reloaded modules — repetition is a no-op.
 */
export function startEventLoopWatchdog(options: EventLoopWatchdogOptions = {}): () => void {
  const s = state();
  const stallMs = options.stallMs ?? numberFromEnv("JARELA_EVENT_LOOP_STALL_MS", DEFAULT_STALL_MS);
  const sampleMs = options.sampleMs ?? numberFromEnv("JARELA_EVENT_LOOP_SAMPLE_MS", DEFAULT_SAMPLE_MS);
  if (stallMs <= 0) return () => undefined;
  if (s.started) return () => undefined;

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  s.started = true;
  s.timer = setInterval(() => {
    const sample = readSample(stallMs, histogram);
    histogram.reset();
    if (sample.maxMs < stallMs) return;
    s.stall_count += 1;
    console.warn(formatStallReport(sample));
  }, sampleMs);
  s.timer.unref?.();

  return () => {
    if (s.timer) clearInterval(s.timer);
    s.timer = null;
    s.started = false;
    histogram.disable();
  };
}

/** Test seam: clears recorded state between assertions. */
export function __resetBlockingWorkDiagnosticsForTests(): void {
  const s = state();
  s.regions.length = 0;
  s.slow_work.length = 0;
  s.slow_statements.length = 0;
  s.stall_count = 0;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
