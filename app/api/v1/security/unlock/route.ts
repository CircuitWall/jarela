/**
 * @public — `POST /api/v1/security/unlock`
 *
 * Decrypts the PIN-wrapped master key with the supplied 6-digit PIN.
 * Rate-limited per remote (3 free attempts, then exponential backoff
 * capped at 5 min). See ADR-0063.
 *
 * Request body: `{ "pin": "123456" }`
 * Responses:
 *   200 `{ ok: true }`            — unlocked successfully
 *   400 `{ error: "bad-pin" }`    — wrong shape (not 6 digits)
 *   401 `{ error: "invalid-pin" }`— PIN didn't decrypt the blob
 *   403 `{ error: "loopback-only" }`
 *   409 `{ error: "not-locked" }` — already unlocked or PIN not set
 *   429 `{ error: "rate-limited", retry_after_ms }`
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  isMasterKeyLocked,
  unlockMasterKey,
  InvalidPinError,
} from "@/lib/crypto/master-key";
import { isLoopbackRequest } from "@/lib/auth/access";
import {
  checkPinRateLimit,
  recordPinFailure,
  recordPinSuccess,
} from "@/lib/auth/pin-rate-limit";

const Body = z.object({ pin: z.string() });

export async function POST(req: Request) {
  if (!isLoopbackRequest(req)) {
    return NextResponse.json({ error: "loopback-only" }, { status: 403 });
  }

  // Touch the DB so master-key bootstrap has run.
  getDb();
  if (!isMasterKeyLocked()) {
    return NextResponse.json({ error: "not-locked" }, { status: 409 });
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
    unlockMasterKey(parsed.data.pin);
    recordPinSuccess(remote);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof InvalidPinError) {
      recordPinFailure(remote);
      return NextResponse.json({ error: "invalid-pin" }, { status: 401 });
    }
    if (err instanceof Error && /6 digits/.test(err.message)) {
      // pin-wrap's assertValidPin rejects wrong shape with a generic
      // Error — surface as 400 not 500.
      return NextResponse.json({ error: "bad-pin" }, { status: 400 });
    }    if (err instanceof Error && /is not locked/.test(err.message)) {
      // Parallel unlock won the race between our isMasterKeyLocked()
      // check and unwrap. The goal state is achieved - treat as success.
      return NextResponse.json({ ok: true });
    }    console.error("[security/unlock] unexpected error:", err);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
