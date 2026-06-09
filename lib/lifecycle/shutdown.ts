// Graceful shutdown coordinator.
//
// Registers SIGINT / SIGTERM (and SIGBREAK on Windows) so Ctrl-C in the
// foreground and `kill`/`systemctl stop`/Task Scheduler "End task" all
// trigger the same drain sequence:
//
//   1. abort every in-flight LangGraph run so stream loops bail out
//   2. stop the scheduler tick so no new firings start
//   3. close every bridge adapter (WhatsApp WS, future kinds) cleanly
//   4. wait briefly for the runs to actually finish flushing
//   5. close the SQLite handle so WAL is checkpointed
//   6. exit 0
//
// A hard timeout aborts the drain if any subsystem hangs — the supervisor
// (Task Scheduler / systemd / installed-launcher.ps1) will then restart us
// instead of leaving a zombie holding the port.
//
// Wired from `instrumentation.ts` so it runs once per server process at
// boot. Idempotent: only the first call installs handlers.

import { getOrCreateGlobal } from "@/lib/utils/global-state";
import { getConfig } from "@/lib/env/config";

interface ShutdownState {
  registered: boolean;
  shuttingDown: boolean;
}
const state = getOrCreateGlobal<ShutdownState>("__jarela_shutdown", () => ({
  registered: false,
  shuttingDown: false,
}));

// JARELA_SHUTDOWN_DRAIN_MS / JARELA_SHUTDOWN_SETTLE_MS override these.
// Captured at handler-install time (boot); these don't hot-reload because
// the handlers close over the values.
const HARD_TIMEOUT_MS = getConfig().shutdownDrainMs;
const RUN_DRAIN_MS = getConfig().shutdownSettleMs;

export function registerShutdownHandlers(): void {
  if (state.registered) return;
  state.registered = true;

  const handler = (signal: NodeJS.Signals) => {
    if (state.shuttingDown) {
      // Second signal while already draining: operator is impatient, exit
      // immediately. Mirrors the behaviour every well-behaved daemon has —
      // first Ctrl-C drains, second Ctrl-C kills.
      console.log(`[jarela] received ${signal} during shutdown; forcing exit.`);
      process.exit(130);
    }
    state.shuttingDown = true;
    console.log(`[jarela] ${signal} received, draining…`);
    void runShutdown().catch((err) => {
      console.error(`[jarela] shutdown error:`, err);
      process.exit(1);
    });
  };

  // Replace any default handlers Next's standalone server may have
  // installed for these signals. Next's default just calls
  // `server.close(() => process.exit(0))`, which races our drain and can
  // exit the process before bridges/DB have flushed. We take over and
  // exit ourselves once drain completes.
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  if (process.platform === "win32") {
    // Ctrl-Break in a foreground PowerShell session lands as SIGBREAK,
    // not SIGINT. Task Scheduler "End task" delivers SIGBREAK as well.
    process.removeAllListeners("SIGBREAK");
    process.on("SIGBREAK", handler);
  }
}

async function runShutdown(): Promise<void> {
  // Safety net: if any drain step deadlocks (e.g. a bridge adapter's
  // socket.close() never resolves), force-exit so the supervisor can
  // restart cleanly instead of holding the port forever.
  const forceExit = setTimeout(() => {
    console.warn(`[jarela] drain exceeded ${HARD_TIMEOUT_MS}ms; forcing exit.`);
    process.exit(130);
  }, HARD_TIMEOUT_MS);
  forceExit.unref?.();

  // 1. Abort in-flight LLM runs. The route's stream loop watches this
  //    AbortController and exits early, emitting a trailing error chunk.
  try {
    const { abortAllRuns } = await import("@/lib/agents/run-registry");
    const n = abortAllRuns("server_shutdown");
    if (n > 0) console.log(`[jarela] aborted ${n} in-flight run(s).`);
  } catch (err) {
    console.error("[jarela] aborting runs failed:", err);
  }

  // 2. Stop the scheduler so no firing kicks off mid-drain.
  try {
    const { stopScheduler } = await import("@/lib/scheduler");
    stopScheduler();
  } catch (err) {
    console.error("[jarela] stopping scheduler failed:", err);
  }

  // 2b. Drain trigger handlers — closes fs.watch watchers and any other
  //     handler that has timers / sockets attached. Independent of the
  //     scheduler tick (those are run-loop ownership; this is per-handler
  //     ownership of OS resources).
  try {
    const { stopAllTriggerHandlers } = await import("@/lib/triggers");
    await stopAllTriggerHandlers();
  } catch (err) {
    console.error("[jarela] stopping trigger handlers failed:", err);
  }

  // 3. Close bridges (WhatsApp Baileys WS, etc).
  try {
    const { stopAllBridges } = await import("@/lib/bridges/runtime");
    await stopAllBridges();
  } catch (err) {
    console.error("[jarela] stopping bridges failed:", err);
  }

  // 4. Give aborted runs a beat to actually finish — they were signalled
  //    in step 1, but the `finally` blocks need ticks to flush trailing
  //    events and persist the partial assistant message.
  try {
    const { waitForRunsToSettle } = await import("@/lib/agents/run-registry");
    const stuck = await waitForRunsToSettle(RUN_DRAIN_MS);
    if (stuck > 0) console.warn(`[jarela] ${stuck} run(s) still active after drain window.`);
  } catch (err) {
    console.error("[jarela] waiting for runs failed:", err);
  }

  // 4b. Stop the async-tool-results sweeper. Holds a setInterval that
  //     would otherwise keep the event loop alive past closeDb().
  try {
    const { stopAsyncResults } = await import("@/lib/tools/async-results");
    stopAsyncResults();
  } catch (err) {
    console.error("[jarela] stopping async-results sweeper failed:", err);
  }

  // 5. Close the DB. WAL is checkpointed so the next boot is fast and we
  //    leave no stale -shm/-wal sidecars on disk.
  try {
    const { closeDb } = await import("@/lib/db");
    closeDb();
  } catch (err) {
    console.error("[jarela] closing db failed:", err);
  }

  clearTimeout(forceExit);
  console.log("[jarela] shutdown complete.");
  process.exit(0);
}
