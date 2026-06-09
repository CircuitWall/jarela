// Node-only bootstrap split out of `instrumentation.ts` so the edge-runtime
// build never has to trace its dependency graph (which transitively pulls
// in node-only modules like `child_process` via the MCP stdio client).
//
// `instrumentation.ts` only loads this file when running on the nodejs
// server in production.

export async function bootNode(): Promise<void> {
  // ADR-0060 — apply persisted env-overrides FIRST so subsequent module
  // imports see the overridden values from the start. Done before the
  // logging / shutdown / tools imports because each of them caches env
  // reads at module-init time.
  const { applyOverridesToProcessEnv } = await import("@/lib/env/overrides");
  const r = applyOverridesToProcessEnv();
  if (r.applied > 0 || r.skipped > 0) {
    // Use raw stdout — console isn't patched yet and we don't want this
    // line to land in the logs panel (the entries it produces would be
    // pre-patch anyway).
    process.stdout.write(
      `[env-overrides] applied ${r.applied}, skipped ${r.skipped} (already in env)\n`,
    );
  }

  // ADR-0058 — install the console patch second so every subsequent
  // boot-time log line lands in the in-memory ring + the live Logs
  // panel feed. Idempotent (guarded by a global Symbol), so dev HMR
  // doesn't double-patch.
  const { installConsolePatch } = await import("@/lib/logging/sink");
  installConsolePatch();

  installGlobalErrorHandlers();

  const { registerShutdownHandlers } = await import("@/lib/lifecycle/shutdown");
  registerShutdownHandlers();

  const { initTools } = await import("@/lib/tools");
  initTools();

  const triggers = await import("@/lib/triggers");
  await triggers.startAllTriggerHandlers();

  const { startScheduler } = await import("@/lib/scheduler");
  startScheduler();

  warnIfExposedBind();
}

function warnIfExposedBind(): void {
  const host = (process.env.HOSTNAME || "").trim();
  if (!host) return;
  const isLoopback =
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host.startsWith("127.");
  if (isLoopback) return;
  if (process.env.JARELA_ALLOW_NONLOOPBACK_BIND === "1") return;
  try {
    const fs: typeof import("node:fs") = require("node:fs");
    if (fs.existsSync("/.dockerenv")) return;
  } catch {
    /* not on a POSIX runtime, ignore */
  }
  if (process.env.KUBERNETES_SERVICE_HOST) return;
  console.warn(
    `\n` +
      `[security] Jarela is bound to ${host}, which is NOT loopback.\n` +
      `           Non-loopback callers are only gated by the Tailscale-User-Login\n` +
      `           header, which can be forged by anyone on the LAN unless a\n` +
      `           Tailscale-Serve (or equivalent reverse proxy) is sitting in\n` +
      `           front of this process and injecting it.\n` +
      `           Bind to 127.0.0.1 or set JARELA_ALLOW_NONLOOPBACK_BIND=1 to\n` +
      `           silence this warning.\n`,
  );
}

// Global last-resort handlers for errors that escape every other try/catch.
// Without these, Node's default behaviour is to print a stack to stderr
// and (for uncaughtException) exit the process. We instead route them
// through the patched console so the in-memory log ring and the Logs
// panel capture them, and we keep the process alive — the launcher
// supervisor already restarts on hard crashes, but most stray rejections
// in HTTP handlers or background jobs shouldn't kill the whole server.
// Idempotent via a Symbol so dev HMR / multiple imports never stack
// handlers (which would double-log every event).
const HANDLERS_INSTALLED: unique symbol = Symbol.for("@jarela/global-error-handlers");
type ProcessWithFlag = NodeJS.Process & { [HANDLERS_INSTALLED]?: true };
function installGlobalErrorHandlers(): void {
  const p = process as ProcessWithFlag;
  if (p[HANDLERS_INSTALLED]) return;
  process.on("uncaughtException", (err, origin) => {
    try {
      console.error(
        `[uncaughtException] origin=${origin}:`,
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
    } catch {
      /* logging itself failed — nothing safe to do */
    }
  });
  process.on("unhandledRejection", (reason) => {
    try {
      console.error(
        `[unhandledRejection]:`,
        reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
      );
    } catch {
      /* logging itself failed — nothing safe to do */
    }
  });
  p[HANDLERS_INSTALLED] = true;
}
