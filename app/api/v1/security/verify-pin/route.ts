/**
 * @public — `POST /api/v1/security/verify-pin`
 *
 * Presence check for the screen-lock overlay. Verifies the supplied PIN
 * against the on-disk PIN-wrapped keyfile WITHOUT touching the in-memory
 * master key (which is still loaded and serving background work).
 *
 * Distinct from `/api/v1/security/unlock`, which is the master-key
 * crypto unlock at boot.
 *
 * Rate-limited per remote, same bucket as the boot-time unlock so an
 * attacker can't drain attempts twice by alternating endpoints.
 *
 * Request body: `{ "pin": "123456" }`
 * Responses:
 *   200 `{ ok: true }`              — pin matched, screen unlocked
 *   400 `{ error: "bad-pin" }`      — wrong shape (not 6 digits)
 *   401 `{ error: "invalid-pin" }`  — PIN didn't decrypt the blob
 *   409 `{ error: "no-pin" }`       — no PIN-wrapped keyfile configured
 *   429 `{ error: "rate-limited", retry_after_ms }`
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  getMasterKeySource,
  verifyPin,
  InvalidPinError,
} from "@/lib/crypto/master-key";
import {
  checkPinRateLimit,
  recordPinFailure,
  recordPinSuccess,
} from "@/lib/auth/pin-rate-limit";
import { unlockScreen } from "@/lib/security/screen-lock";

const Body = z.object({ pin: z.string() });

// Reachable from any whitelisted caller (loopback OR a Tailscale
// identity vetted by proxy.ts) so the mobile PWA can clear the screen
// lock. The PIN itself is still the security boundary, and the
// rate-limit bucket is keyed on x-forwarded-for so each remote gets
// its own attempts budget.
export async function POST(req: Request) {
  // Ensure master-key bootstrap has run so getMasterKeySource() is meaningful.
  getDb();
  if (getMasterKeySource() !== "pin-wrapped-keyfile") {
    return NextResponse.json({ error: "no-pin" }, { status: 409 });
  }

  const remote = req.headers.get("x-forwarded-for") ?? "loopback";
  const rl = checkPinRateLimit(remote);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate-limited", retry_after_ms: rl.retryAfterMs },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad-pin" }, { status: 400 });
  }

  try {
    verifyPin(parsed.data.pin);
    recordPinSuccess(remote);
    unlockScreen();
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof InvalidPinError) {
      recordPinFailure(remote);
      return NextResponse.json({ error: "invalid-pin" }, { status: 401 });
    }
    if (err instanceof Error && /6 digits/.test(err.message)) {
      return NextResponse.json({ error: "bad-pin" }, { status: 400 });
    }
    console.error("[security/verify-pin] unexpected error:", err);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
