/**
 * @public — `GET /api/v1/security/state`
 *
 * Reports the master-key lock state and whether the PIN is enabled so
 * the splash UI can decide whether to render the PIN pad and the
 * Security panel can show the right enable/change/disable buttons.
 * Also reports the screen-lock state for the idle-timeout overlay.
 * See ADR-0063.
 */

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  getMasterKeySource,
  getMasterKeyState,
} from "@/lib/crypto/master-key";
import {
  isScreenLocked,
  getIdleTimeoutMs,
} from "@/lib/security/screen-lock";

// Reachable from any whitelisted caller (loopback OR a Tailscale
// identity already vetted by proxy.ts) — the mobile PWA polls this to
// detect screen-lock state. Reports no secrets, just lock flags.
export function GET(_req: Request) {
  // Touch the DB so initMasterKey() has definitely run.
  getDb();
  const source = getMasterKeySource();
  const pinEnabled = source === "pin-wrapped-keyfile";
  return NextResponse.json({
    state: getMasterKeyState(),
    source,
    pin_enabled: pinEnabled,
    // Screen-lock fields only meaningful when PIN is set; report them
    // regardless so the client doesn't have to branch on shape.
    screen_locked: pinEnabled && isScreenLocked(),
    idle_timeout_ms: getIdleTimeoutMs(),
  });
}

