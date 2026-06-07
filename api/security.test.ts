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
    expect(body).toEqual({
      state: "locked",
      source: "pin-wrapped-keyfile",
      pin_enabled: true,
    });
  });

  it("blocks tailnet callers with 403", () => {
    const res = stateRoute.GET(tailnet({ url: "http://hostname.tail.ts/api/v1/security/state" }));
    expect(res.status).toBe(403);
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
});
