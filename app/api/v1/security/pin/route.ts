/**
 * @public — `POST /api/v1/security/pin`
 *
 * Enable, change, or disable the at-rest PIN (ADR-0063).
 *
 * Request body:
 *   `{ "action": "enable",  "newPin": "123456" }`
 *   `{ "action": "change",  "currentPin": "123456", "newPin": "654321" }`
 *   `{ "action": "disable", "currentPin": "123456" }`
 *
 * The master key must be unlocked (the user just typed the splash PIN
 * or the keychain/keyfile path is in use). Wrong currentPin returns
 * 401 and counts against the same rate limiter as /unlock.
 *
 * Responses:
 *   200 `{ ok: true, source }`
 *   400 `{ error: "bad-request" | "bad-pin" }`
 *   401 `{ error: "invalid-pin" }`
 *   403 `{ error: "loopback-only" }`
 *   409 `{ error: "wrong-state" }` — e.g. enable when already enabled
 *   423 `{ error: "locked" }`      — master key still locked
 *   429 `{ error: "rate-limited", retry_after_ms }`
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  disablePin,
  getMasterKeySource,
  isMasterKeyLocked,
  setPin,
  InvalidPinError,
  MasterKeyLockedError,
} from "@/lib/crypto/master-key";
import { isLoopbackRequest } from "@/lib/auth/access";
import {
  checkPinRateLimit,
  recordPinFailure,
  recordPinSuccess,
} from "@/lib/auth/pin-rate-limit";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enable"), newPin: z.string() }),
  z.object({ action: z.literal("change"), currentPin: z.string(), newPin: z.string() }),
  z.object({ action: z.literal("disable"), currentPin: z.string() }),
]);

export async function POST(req: Request) {
  if (!isLoopbackRequest(req)) {
    return NextResponse.json({ error: "loopback-only" }, { status: 403 });
  }

  getDb();
  if (isMasterKeyLocked()) {
    return NextResponse.json({ error: "locked" }, { status: 423 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "bad-request" }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad-request" }, { status: 400 });
  }

  const remote = req.headers.get("x-forwarded-for") ?? "loopback";
  // Rate-limit any flow that takes a currentPin — those are the brute-
  // forceable ones. Enable doesn't require a current PIN so it bypasses.
  if (parsed.data.action !== "enable") {
    const rl = checkPinRateLimit(remote);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "rate-limited", retry_after_ms: rl.retryAfterMs },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
      );
    }
  }

  const currentSource = getMasterKeySource();
  const pinEnabled = currentSource === "pin-wrapped-keyfile";

  try {
    switch (parsed.data.action) {
      case "enable": {
        if (pinEnabled) {
          return NextResponse.json({ error: "wrong-state" }, { status: 409 });
        }
        setPin({ newPin: parsed.data.newPin });
        break;
      }
      case "change": {
        if (!pinEnabled) {
          return NextResponse.json({ error: "wrong-state" }, { status: 409 });
        }
        setPin({ currentPin: parsed.data.currentPin, newPin: parsed.data.newPin });
        recordPinSuccess(remote);
        break;
      }
      case "disable": {
        if (!pinEnabled) {
          return NextResponse.json({ error: "wrong-state" }, { status: 409 });
        }
        disablePin(parsed.data.currentPin);
        recordPinSuccess(remote);
        break;
      }
    }
    return NextResponse.json({ ok: true, source: getMasterKeySource() });
  } catch (err) {
    if (err instanceof InvalidPinError) {
      if (parsed.data.action !== "enable") recordPinFailure(remote);
      return NextResponse.json({ error: "invalid-pin" }, { status: 401 });
    }
    if (err instanceof MasterKeyLockedError) {
      return NextResponse.json({ error: "locked" }, { status: 423 });
    }
    if (err instanceof Error && /6 digits/.test(err.message)) {
      return NextResponse.json({ error: "bad-pin" }, { status: 400 });
    }
    console.error("[security/pin] unexpected error:", err);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
