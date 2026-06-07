/**
 * @public — `GET/PATCH /api/v1/security/idle-timeout`
 *
 * Reads or updates the screen-lock idle timeout. The value persists
 * across restarts (stored in app-settings). 0 disables the auto-lock.
 *
 * GET returns:  `{ idle_timeout_ms: number }`
 * PATCH body:   `{ idle_timeout_ms: number }` (0 to 24h)
 * PATCH returns: `{ idle_timeout_ms: number }`
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  getIdleTimeoutMs,
  setIdleTimeoutMs,
} from "@/lib/security/screen-lock";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const PatchBody = z.object({
  idle_timeout_ms: z.number().int().min(0).max(ONE_DAY_MS),
});

// Reachable from any whitelisted caller so the settings UI can render
// + adjust the timeout from any device. The proxy's tailscale-identity
// gate is the security boundary.
export function GET(_req: Request) {
  getDb();
  return NextResponse.json({ idle_timeout_ms: getIdleTimeoutMs() });
}

export async function PATCH(req: Request) {
  getDb();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad-timeout" }, { status: 400 });
  }

  setIdleTimeoutMs(parsed.data.idle_timeout_ms);
  return NextResponse.json({ idle_timeout_ms: getIdleTimeoutMs() });
}
