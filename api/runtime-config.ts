// Browser-side cache of the server's effective config snapshot.
//
// api/client.ts and a few UI widgets (ServerStatus, the chat SSE consumer)
// read JARELA_* timeouts that the user can change via the EnvVarsPanel.
// Browser code can't read process.env directly, so we expose the relevant
// fields via /api/v1/config and cache the response here.
//
// Reads are non-blocking: the schema defaults are used until the first
// fetch lands, after which subsequent reads pick up overrides.

interface RuntimeConfigSnapshot {
  httpRequestTimeoutMs: number;
  sseConnectTimeoutMs: number;
  healthCheckTimeoutMs: number;
  httpMaxAttempts: number;
  runMaxMs: number;
}

// Mirror of ENV_DEFAULTS — these defaults are also the schema defaults so
// the client behaves identically until the first /api/v1/config response
// lands. Don't import the schema directly: it pulls in node-only modules
// (homedir, path) via lib/env/config.ts and breaks the browser bundle.
const FALLBACK: RuntimeConfigSnapshot = {
  httpRequestTimeoutMs: 30_000,
  sseConnectTimeoutMs: 30_000,
  healthCheckTimeoutMs: 8_000,
  httpMaxAttempts: 3,
  runMaxMs: 20 * 60_000,
};

let current: RuntimeConfigSnapshot = FALLBACK;
let inflight: Promise<void> | null = null;

export function runtimeConfig(): RuntimeConfigSnapshot {
  // Kick off the lazy fetch on first read; subsequent reads see the
  // updated snapshot once it resolves. Failures keep using FALLBACK.
  if (typeof window !== "undefined" && !inflight) {
    inflight = fetch("/api/v1/config", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Partial<RuntimeConfigSnapshot>>) : null))
      .then((data) => {
        if (!data) return;
        current = {
          httpRequestTimeoutMs: typeof data.httpRequestTimeoutMs === "number" ? data.httpRequestTimeoutMs : current.httpRequestTimeoutMs,
          sseConnectTimeoutMs: typeof data.sseConnectTimeoutMs === "number" ? data.sseConnectTimeoutMs : current.sseConnectTimeoutMs,
          healthCheckTimeoutMs: typeof data.healthCheckTimeoutMs === "number" ? data.healthCheckTimeoutMs : current.healthCheckTimeoutMs,
          httpMaxAttempts: typeof data.httpMaxAttempts === "number" ? data.httpMaxAttempts : current.httpMaxAttempts,
          runMaxMs: typeof data.runMaxMs === "number" ? data.runMaxMs : current.runMaxMs,
        };
      })
      .catch(() => { /* keep fallback */ });
  }
  return current;
}

/** Force a refetch — call after the EnvVarsPanel PATCHes a runtime knob. */
export function refreshRuntimeConfig(): void {
  inflight = null;
  runtimeConfig();
}
