// Next.js instrumentation hook — runs once per server process at startup.
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
//
// We use it to eagerly load external tools so their files are validated
// and any errors are surfaced at boot rather than on first agent turn.

export async function register() {
  // Only run server-side (nodejs runtime); the edge runtime can't `require`
  // arbitrary files from disk.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Install SIGINT/SIGTERM handlers before any subsystem spins up so a
  // signal that arrives during boot still drains cleanly.
  const { registerShutdownHandlers } = await import("@/lib/lifecycle/shutdown");
  registerShutdownHandlers();

  // Dynamic import so this module stays edge-safe.
  const { initTools } = await import("@/lib/tools");
  initTools();

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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs: typeof import("node:fs") = require("node:fs");
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
