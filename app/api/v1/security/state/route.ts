/**
 * @public — `GET /api/v1/security/state`
 *
 * Reports the master-key lock state and whether the PIN is enabled so
 * the splash UI can decide whether to render the PIN pad and the
 * Security panel can show the right enable/change/disable buttons.
 * See ADR-0063.
 */

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  getMasterKeySource,
  getMasterKeyState,
} from "@/lib/crypto/master-key";
import { isLoopbackRequest } from "@/lib/auth/access";

export function GET(req: Request) {
  if (!isLoopbackRequest(req)) {
    return NextResponse.json({ error: "loopback-only" }, { status: 403 });
  }
  // Touch the DB so initMasterKey() has definitely run.
  getDb();
  const source = getMasterKeySource();
  return NextResponse.json({
    state: getMasterKeyState(),
    source,
    pin_enabled: source === "pin-wrapped-keyfile",
  });
}
