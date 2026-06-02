// Public read of the current effective config.
//
// Browser / mobile / extension code can fetch this once at boot to learn
// the active timeouts (HTTP request, SSE connect, health-check) so those
// stop being hard-coded build-time constants. Server-side code keeps using
// getConfig() directly.
//
// Only operationally-safe fields are surfaced — no credentials or
// install-path data. Anything in this response is also visible via the
// EnvVarsPanel.

import { NextResponse } from "next/server";
import { getConfig } from "@/lib/env/config";

export function GET(): Response {
  const c = getConfig();
  return NextResponse.json({
    // network
    httpRequestTimeoutMs: c.httpRequestTimeoutMs,
    sseConnectTimeoutMs: c.sseConnectTimeoutMs,
    healthCheckTimeoutMs: c.healthCheckTimeoutMs,
    httpMaxAttempts: c.httpMaxAttempts,
    // app metadata (already public via /api/v1/agents and the manifest)
    appName: c.appName,
    appDescription: c.appDescription,
    issueUrl: c.issueUrl,
  });
}
