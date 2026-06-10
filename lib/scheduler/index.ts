// Scheduler loop. Owns the timer + the "is a tick in flight?" guard. The
// actual firing logic lives in lib/triggers — this file only schedules
// runTriggerTick() and exports a "Run now" helper that the existing
// scheduled-tasks HTTP route uses.
import { getOrCreateGlobal } from "@/lib/utils/global-state";
import { indexAllSources } from "@/lib/documents/indexer";
import { runTriggerTick, runScheduledTaskFiringNow } from "@/lib/triggers";
import { runAllHealthProbes } from "@/lib/health/runner";
import { isMasterKeyLocked, onMasterKeyUnlocked } from "@/lib/crypto/master-key";
import {
  getDueTasks,
  markTasksDeferred,
  type ScheduledTaskRow,
} from "@/lib/stores/scheduled-tasks";

// Env-tunable so e2e tests can ride a tighter loop without waiting 30 s
// per fs-watch firing. Production / dev use the 30 s default; tests
// should set JARELA_SCHEDULER_TICK_MS=200 (or similar).
const POLL_INTERVAL_MS = (() => {
  const raw = process.env.JARELA_SCHEDULER_TICK_MS;
  if (!raw) return 30_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 50 ? n : 30_000;
})();
// Sweep document sources every Nth tick. 20 ticks × 30s = 10 min, which
// matches typical "I edited a file, ask Jarela about it" patience. PR-D
// upgrades this to event-driven fs watching.
const DOC_SWEEP_EVERY_TICKS = 20;
// Probe integrations + LLM keys every Nth tick. 20 ticks × 30s = 10 min
// — frequent enough that a freshly-expired token surfaces in roughly the
// same window as a doc-source sweep, cheap enough that we don't hammer
// the vendor /me endpoints. The health runner itself dedups alerts so
// repeated failures only re-fire on its own (longer) backoff.
const HEALTH_SWEEP_EVERY_TICKS = 20;

interface SchedulerState {
  started: boolean;
  timer: NodeJS.Timeout | null;
  running: boolean;
  tickCount: number;
  healthTickCount: number;
  // Count of scheduled tasks deferred on the previous locked tick. Only
  // log the deferral when this transitions (0 → N, N → M) so a long
  // lock window doesn't spam the console every 30s.
  lastDeferredCount: number;
}
const state = getOrCreateGlobal<SchedulerState>("__jarela_scheduler", () => ({
  started: false,
  timer: null,
  running: false,
  tickCount: 0,
  healthTickCount: 0,
  lastDeferredCount: 0,
}));

const LOCKED_DEFERRAL_REASON =
  "Deferred: app was locked when this task was due. It will run as soon as the app is unlocked.";

// Idempotent — call repeatedly; only the first call starts the loop.
export function startScheduler(): void {
  if (state.started) return;
  state.started = true;
  setImmediate(() => { void tick(); });
  state.timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  if (typeof state.timer.unref === "function") state.timer.unref();
  // Fire the first health probe immediately (instead of waiting 10min)
  // so a freshly-started server surfaces a broken token / unreachable
  // vendor on the first SSE subscription. Fire-and-forget; cheap.
  if (!isMasterKeyLocked()) {
    runAllHealthProbes().catch((err) => {
      console.error(
        "[scheduler] initial health probe failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }
  // Drain catch-up firings the moment the user unlocks, instead of
  // waiting up to POLL_INTERVAL_MS for the next timer tick. Idempotent:
  // onMasterKeyUnlocked runs the callback synchronously if already
  // unlocked, and tick() is internally guarded against re-entry.
  onMasterKeyUnlocked(() => { setImmediate(() => { void tick(); }); });
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
  // Skip the firing phase while the at-rest key is locked (ADR-0063):
  // every encrypted store read inside the agent runner would throw
  // MasterKeyLockedError. Before returning, surface any due scheduled
  // tasks so the user can see WHY they didn't fire — both in the logs
  // and in the Tasks panel (last_error column). The plain-text
  // scheduled_tasks table itself is readable while locked.
  if (isMasterKeyLocked()) {
    try {
      const due = getDueTasks();
      const ids = due.map((t) => t.id);
      if (ids.length > 0) {
        markTasksDeferred(ids, LOCKED_DEFERRAL_REASON);
      }
      if (ids.length !== state.lastDeferredCount) {
        if (ids.length > 0) {
          console.warn(
            `[scheduler] ${ids.length} scheduled task(s) deferred — app is locked. ` +
              `They will fire as soon as the user unlocks via the splash.`,
          );
        } else if (state.lastDeferredCount > 0) {
          console.log("[scheduler] no more deferred tasks pending");
        }
        state.lastDeferredCount = ids.length;
      }
    } catch (err) {
      console.error(
        "[scheduler] locked-tick deferral bookkeeping failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return;
  }
  state.lastDeferredCount = 0;
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

    // Health probe sweep. Tracks integrations + LLM keys, publishes
    // health_alert notifications on state transitions. Runs out-of-band
    // from triggers so a slow vendor doesn't delay scheduled-task firing.
    state.healthTickCount = (state.healthTickCount + 1) % HEALTH_SWEEP_EVERY_TICKS;
    if (state.healthTickCount === 0) {
      runAllHealthProbes().catch((err) => {
        console.error(
          "[scheduler] health probe sweep failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
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
