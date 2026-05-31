// Node-only bootstrap split out of `instrumentation.ts` so the edge-runtime
// build never has to trace its dependency graph (which transitively pulls
// in node-only modules like `child_process` via the MCP stdio client).
//
// `instrumentation.ts` only loads this file when running on the nodejs
// server in production.

export async function bootNode(): Promise<void> {
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
