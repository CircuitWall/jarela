// Next.js instrumentation hook — runs once per server process at startup.
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
//
// This file is built for BOTH the nodejs and edge runtimes, so it must stay
// free of any node-only imports. The real bootstrap (tools, triggers,
// scheduler, shutdown handlers) lives in `instrumentation-node.ts`, which
// is only loaded when we're actually running on the nodejs server.

export async function register() {
  // Dev server should stay render-first; skip eager bootstrapping to avoid
  // pulling optional Node-only integrations into the dev compiler.
  if (process.env.NODE_ENV === "development") return;
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { bootNode } = await import("./instrumentation-node");
    await bootNode();
  } catch (err) {
    // A boot-time failure (env-overrides corrupt, console patch broken,
    // trigger registry import fails, …) leaves the server in a
    // half-initialized state where Next.js will happily start the HTTP
    // listener and serve 5xx forever. Print a diagnostic to stderr (the
    // log sink may not be live yet) and exit non-zero so the launcher
    // supervisor (start-jarela.ps1, systemd, launchd, Task Scheduler)
    // restarts us cleanly. The 250ms grace gives stderr a chance to flush.
    const stack = err instanceof Error && err.stack ? err.stack : String(err);
    process.stderr.write(`[boot] unrecoverable failure during bootNode: ${stack}\n`);
    setTimeout(() => process.exit(1), 250).unref?.();
  }
}
