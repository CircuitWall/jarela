// Next.js instrumentation hook — runs once per server process at startup.
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
//
// We use it to eagerly load external tools so their files are validated
// and any errors are surfaced at boot rather than on first agent turn.

export async function register() {
  // Dev server should stay render-first; skip eager bootstrapping to avoid
  // pulling optional Node-only integrations into the dev compiler.
  if (process.env.NODE_ENV === "development") return;

  // Only run server-side (nodejs runtime); the edge runtime can't `require`
  // arbitrary files from disk.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Resolve startup-only modules at runtime so webpack doesn't try to trace
  // their Node-only dependency graphs for non-node runtimes.
  const req = (0, eval)("require") as NodeRequire;

  // Install SIGINT/SIGTERM handlers before any subsystem spins up so a
  // signal that arrives during boot still drains cleanly.
  const { registerShutdownHandlers } = req("./lib/lifecycle/shutdown") as typeof import("@/lib/lifecycle/shutdown");
  registerShutdownHandlers();

  const { initTools } = req("./lib/tools") as typeof import("@/lib/tools");
  initTools();

  // Boot trigger handlers (scheduled-task is registered eagerly; the
  // fs-watch + fast-sweep handlers need an explicit start() call to
  // attach their watchers). Importing the module also wires the
  // built-in scripts.
  const triggers = req("./lib/triggers") as typeof import("@/lib/triggers");
  await triggers.startAllTriggerHandlers();

  // Boot the scheduler unconditionally so trigger handlers (fs-watch,
  // fast remote sweep) get fan-out ticks even if no thread / event /
  // scheduled-task call has lazily started it yet.
  const { startScheduler } = req("./lib/scheduler") as typeof import("@/lib/scheduler");
  startScheduler();

  // Loud warning if the server is bound to a non-loopback interface
  // without being inside a container. The auth middleware
  // (lib/auth/access.ts) gates non-loopback callers behind a
  // `Tailscale-User-Login` header — which is trivially forgeable by
  // anyone on the LAN if Tailscale Serve isn't doing the SNI/header
  // injection in front of us. The Docker image legitimately binds
  // 0.0.0.0 because the container's network namespace contains nothing
  // else, so we suppress the warning there.
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
  // Container heuristics: Docker sets /.dockerenv; Kubernetes/runc set
  // KUBERNETES_SERVICE_HOST. In both cases the operator is intentionally
  // binding 0.0.0.0 to the pod's network namespace and reverse-proxying
  // in front of it.
  try {
    const req = (0, eval)("require") as NodeRequire;
    const fs = req("fs") as typeof import("node:fs");
    if (fs.existsSync("/.dockerenv")) return;
  } catch {
    // not on a POSIX runtime, ignore
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
