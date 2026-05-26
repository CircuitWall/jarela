// Scheduler loop. Owns the timer + the "is a tick in flight?" guard. The
// actual firing logic lives in lib/triggers — this file only schedules
// runTriggerTick() and exports a "Run now" helper that the existing
// scheduled-tasks HTTP route uses.
import { getOrCreateGlobal } from "@/lib/utils/global-state";
import { indexAllSources } from "@/lib/documents/indexer";
import { runTriggerTick, runScheduledTaskFiringNow } from "@/lib/triggers";
import type { ScheduledTaskRow } from "@/lib/stores/scheduled-tasks";

const POLL_INTERVAL_MS = 30_000;
// Sweep document sources every Nth tick. 20 ticks × 30s = 10 min, which
// matches typical "I edited a file, ask Jarela about it" patience. PR-D
// upgrades this to event-driven fs watching.
const DOC_SWEEP_EVERY_TICKS = 20;

interface SchedulerState {
  started: boolean;
  timer: NodeJS.Timeout | null;
  running: boolean;
  tickCount: number;
}
const state = getOrCreateGlobal<SchedulerState>("__jarela_scheduler", () => ({
  started: false,
  timer: null,
  running: false,
  tickCount: 0,
}));

// Idempotent — call repeatedly; only the first call starts the loop.
export function startScheduler(): void {
  if (state.started) return;
  state.started = true;
  setImmediate(() => { void tick(); });
  state.timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  if (typeof state.timer.unref === "function") state.timer.unref();
}

export function stopScheduler(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.started = false;
}

async function tick(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    await runTriggerTick();

    // Document-RAG reindex sweep (ADR-0024). Polled here until PR-D wires
    // an fs watcher. Failures are logged but never block the tick.
    state.tickCount = (state.tickCount + 1) % DOC_SWEEP_EVERY_TICKS;
    if (state.tickCount === 0) {
      try {
        await indexAllSources();
      } catch (err) {
        console.error(
          "[scheduler] document index sweep failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } finally {
    state.running = false;
  }
}

/**
 * Public wrapper retained for the "Run now" UI button + HTTP route.
 * Internally delegates to the trigger runner so the manual path and the
 * tick path share the exact same code.
 */
export async function runScheduledTaskNow(task: ScheduledTaskRow): Promise<void> {
  await runScheduledTaskFiringNow(task.id);
}
