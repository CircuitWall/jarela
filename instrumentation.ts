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
}
