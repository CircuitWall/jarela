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

  const { bootNode } = await import("./instrumentation-node");
  await bootNode();
}
