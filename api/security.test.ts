import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { wrapMasterKey } from "@/lib/crypto/pin-wrap";
import { __resetMasterKeyForTests, initMasterKey } from "@/lib/crypto/master-key";
import { __resetPinRateLimitForTests } from "@/lib/auth/pin-rate-limit";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-security-route-"));
process.env.JARELA_DB_DIR = tmpRoot;

// Pre-seed a PIN-wrapped keyfile so the routes boot into the locked state.
const PIN = "424242";
const masterKey = Buffer.alloc(32, 0x99);
writeFileSync(join(tmpRoot, ".secret-key.enc"), wrapMasterKey(masterKey, PIN));

const stateRoute = await import("@/app/api/v1/security/state/route");
const unlockRoute = await import("@/app/api/v1/security/unlock/route");
const verifyPinRoute = await import("@/app/api/v1/security/verify-pin/route");
const idleTimeoutRoute = await import("@/app/api/v1/security/idle-timeout/route");
const screenLock = await import("@/lib/security/screen-lock");

function loopback(init?: RequestInit & { url?: string }): Request {
  const url = init?.url ?? "http://localhost:4312/api/v1/security/unlock";
  return new Request(url, {
    ...init,
    headers: {
      host: "localhost:4312",
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

function tailnet(init?: RequestInit & { url?: string }): Request {
  const url = init?.url ?? "http://hostname.tail.ts/api/v1/security/unlock";
  return new Request(url, {
    ...init,
    headers: {
      host: "hostname.tail.ts",
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

beforeEach(() => {
  // Re-arm the locked state and clear rate-limit history so every test
  // starts from a clean slate. getDb()'s cache is unaffected, but the
  // routes consult the master-key module directly for the lock check.
  __resetPinRateLimitForTests();
  __resetMasterKeyForTests();
  initMasterKey(tmpRoot);
});

afterAll(() => {
  __resetMasterKeyForTests();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("GET /api/v1/security/state", () => {
  it("reports locked + pin_enabled when the wrapped keyfile is present", async () => {
    const res = stateRoute.GET(loopback({ url: "http://localhost:4312/api/v1/security/state" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      state: "locked",
      source: "pin-wrapped-keyfile",
      pin_enabled: true,
      screen_locked: false,
    });
    expect(typeof body.idle_timeout_ms).toBe("number");
  });

  it("reports screen_locked when the screen lock is engaged", async () => {
    // Unlock the master key first — the screen-lock state is only
    // meaningful once PIN-protected content is unlocked.
    await unlockRoute.POST(loopback({
      method: "POST",
      body: JSON.stringify({ pin: PIN }),
    }));
    screenLock.lockScreen();
    const res = stateRoute.GET(loopback({ url: "http://localhost:4312/api/v1/security/state" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.screen_locked).toBe(true);
    screenLock.unlockScreen();
  });

  it("is reachable from tailnet callers (gated upstream by proxy.ts whitelist)", () => {
    const res = stateRoute.GET(tailnet({ url: "http://hostname.tail.ts/api/v1/security/state" }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/v1/security/unlock", () => {
  it("returns 401 on wrong PIN", async () => {
    const bad = await unlockRoute.POST(loopback({
      method: "POST",
      body: JSON.stringify({ pin: "000000" }),
    }));
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "invalid-pin" });
  });

  it("returns 200 on right PIN and 409 on subsequent unlock", async () => {
    const good = await unlockRoute.POST(loopback({
      method: "POST",
      body: JSON.stringify({ pin: PIN }),
    }));
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ok: true });

    const dup = await unlockRoute.POST(loopback({
      method: "POST",
      body: JSON.stringify({ pin: PIN }),
    }));
    expect(dup.status).toBe(409);
  });

  it("returns 400 on malformed PIN", async () => {
    const res = await unlockRoute.POST(loopback({
      method: "POST",
      body: JSON.stringify({ pin: "abc" }),
    }));
    expect(res.status).toBe(400);
  });

  it("rate-limits after enough failures (per remote)", async () => {
    for (let i = 0; i < 5; i++) {
      await unlockRoute.POST(loopback({
        method: "POST",
        body: JSON.stringify({ pin: "000000" }),
      }));
    }
    const limited = await unlockRoute.POST(loopback({
      method: "POST",
      body: JSON.stringify({ pin: "000000" }),
    }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
  });

  it("is reachable from tailnet callers (gated upstream by proxy.ts whitelist)", async () => {
    const res = await unlockRoute.POST(tailnet({
      url: "http://hostname.tail.ts/api/v1/security/unlock",
      method: "POST",
      body: JSON.stringify({ pin: PIN }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("also clears the screen-lock flag so a simultaneous idle lock doesn't re-prompt", async () => {
    screenLock.lockScreen();
    expect(screenLock.isScreenLocked()).toBe(true);
    const res = await unlockRoute.POST(loopback({
      method: "POST",
      body: JSON.stringify({ pin: PIN }),
    }));
    expect(res.status).toBe(200);
    expect(screenLock.isScreenLocked()).toBe(false);
  });
});

// Helpers for the verify-pin/idle-timeout suites — they need the master
// key unlocked because verifyPin reads the keyfile from disk and idle
// settings get persisted via the DB-backed app-settings store.
async function unlockMasterKey() {
  const r = await unlockRoute.POST(loopback({
    method: "POST",
    body: JSON.stringify({ pin: PIN }),
  }));
  expect(r.status).toBe(200);
}

describe("POST /api/v1/security/verify-pin", () => {
  beforeEach(async () => {
    await unlockMasterKey();
    // Engage the screen lock so verify-pin has something to clear.
    screenLock.lockScreen();
  });

  it("returns 200 and clears the screen lock on the right PIN", async () => {
    const res = await verifyPinRoute.POST(loopback({
      url: "http://localhost:4312/api/v1/security/verify-pin",
      method: "POST",
      body: JSON.stringify({ pin: PIN }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(screenLock.isScreenLocked()).toBe(false);
  });

  it("returns 401 on wrong PIN and leaves the screen locked", async () => {
    const res = await verifyPinRoute.POST(loopback({
      url: "http://localhost:4312/api/v1/security/verify-pin",
      method: "POST",
      body: JSON.stringify({ pin: "000000" }),
    }));
    expect(res.status).toBe(401);
    expect(screenLock.isScreenLocked()).toBe(true);
  });

  it("returns 400 on malformed PIN", async () => {
    const res = await verifyPinRoute.POST(loopback({
      url: "http://localhost:4312/api/v1/security/verify-pin",
      method: "POST",
      body: JSON.stringify({ pin: "abc" }),
    }));
    expect(res.status).toBe(400);
  });

  it("is reachable from tailnet callers (gated upstream by proxy.ts whitelist)", async () => {
    const res = await verifyPinRoute.POST(tailnet({
      url: "http://hostname.tail.ts/api/v1/security/verify-pin",
      method: "POST",
      body: JSON.stringify({ pin: PIN }),
    }));
    expect(res.status).toBe(200);
  });
});

describe("idle-timeout route", () => {
  beforeEach(async () => {
    await unlockMasterKey();
  });

  it("GET returns the current timeout", async () => {
    const res = idleTimeoutRoute.GET(loopback({
      url: "http://localhost:4312/api/v1/security/idle-timeout",
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.idle_timeout_ms).toBe("number");
    expect(body.idle_timeout_ms).toBeGreaterThanOrEqual(0);
  });

  it("PATCH updates the timeout and GET reflects it", async () => {
    const patch = await idleTimeoutRoute.PATCH(loopback({
      url: "http://localhost:4312/api/v1/security/idle-timeout",
      method: "PATCH",
      body: JSON.stringify({ idle_timeout_ms: 5_000 }),
    }));
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ idle_timeout_ms: 5_000 });

    const get = idleTimeoutRoute.GET(loopback({
      url: "http://localhost:4312/api/v1/security/idle-timeout",
    }));
    expect((await get.json()).idle_timeout_ms).toBe(5_000);
  });

  it("PATCH rejects out-of-range values", async () => {
    const res = await idleTimeoutRoute.PATCH(loopback({
      url: "http://localhost:4312/api/v1/security/idle-timeout",
      method: "PATCH",
      body: JSON.stringify({ idle_timeout_ms: -1 }),
    }));
    expect(res.status).toBe(400);
  });

  it("PATCH rejects more than 24h", async () => {
    const res = await idleTimeoutRoute.PATCH(loopback({
      url: "http://localhost:4312/api/v1/security/idle-timeout",
      method: "PATCH",
      body: JSON.stringify({ idle_timeout_ms: 25 * 60 * 60 * 1000 }),
    }));
    expect(res.status).toBe(400);
  });

  it("is reachable from tailnet callers (gated upstream by proxy.ts whitelist)", async () => {
    const get = idleTimeoutRoute.GET(tailnet({
      url: "http://hostname.tail.ts/api/v1/security/idle-timeout",
    }));
    expect(get.status).toBe(200);

    const patch = await idleTimeoutRoute.PATCH(tailnet({
      url: "http://hostname.tail.ts/api/v1/security/idle-timeout",
      method: "PATCH",
      body: JSON.stringify({ idle_timeout_ms: 5_000 }),
    }));
    expect(patch.status).toBe(200);
  });
});

