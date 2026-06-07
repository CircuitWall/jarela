import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Each test resets module state via globalThis cleanup (cheaper than
// re-importing — the module is small and side-effect-free aside from
// the globalThis pin).
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-screen-lock-"));
process.env.JARELA_DB_DIR = tmpRoot;

const screenLock = await import("@/lib/security/screen-lock");
const { getDb } = await import("@/lib/db");

const g = globalThis as unknown as {
  __jarelaScreenLock?: {
    lastActivity: number;
    idleTimeoutMs: number;
    locked: boolean;
    hydrated: boolean;
  };
};

function resetState(idleTimeoutMs = 60 * 60 * 1000) {
  // The module captured a reference to this object on first import, so
  // we have to mutate it in place — reassigning the globalThis slot
  // would leave the module reading stale state.
  if (!g.__jarelaScreenLock) {
    // First call: importing the module above already created the slot.
    // If not, fall back to creating it ourselves.
    g.__jarelaScreenLock = {
      lastActivity: Date.now(),
      idleTimeoutMs,
      locked: false,
      hydrated: true,
    };
    return;
  }
  g.__jarelaScreenLock.lastActivity = Date.now();
  g.__jarelaScreenLock.idleTimeoutMs = idleTimeoutMs;
  g.__jarelaScreenLock.locked = false;
  g.__jarelaScreenLock.hydrated = true;
}

beforeEach(() => {
  // Force the DB into existence so the persistence calls in
  // setIdleTimeoutMs have a place to write. Cheap (in-memory).
  getDb();
  resetState();
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("recordUserActivity + isScreenLocked", () => {
  it("starts unlocked with a fresh timer", () => {
    expect(screenLock.isScreenLocked()).toBe(false);
  });

  it("flips to locked once the idle window elapses", () => {
    resetState(50); // 50 ms
    // Backdate the last-activity timestamp past the window.
    g.__jarelaScreenLock!.lastActivity = Date.now() - 200;
    expect(screenLock.isScreenLocked()).toBe(true);
  });

  it("recordUserActivity pushes the timer forward when unlocked", () => {
    resetState(50);
    g.__jarelaScreenLock!.lastActivity = Date.now() - 10;
    screenLock.recordUserActivity();
    expect(screenLock.isScreenLocked()).toBe(false);
  });

  it("recordUserActivity is a no-op while locked", () => {
    resetState(50);
    g.__jarelaScreenLock!.locked = true;
    const before = g.__jarelaScreenLock!.lastActivity;
    screenLock.recordUserActivity();
    expect(g.__jarelaScreenLock!.lastActivity).toBe(before);
    expect(screenLock.isScreenLocked()).toBe(true);
  });

  it("idleTimeoutMs of 0 disables the auto-lock", () => {
    resetState(0);
    g.__jarelaScreenLock!.lastActivity = Date.now() - 1_000_000_000;
    expect(screenLock.isScreenLocked()).toBe(false);
  });
});

describe("unlockScreen + lockScreen", () => {
  it("unlockScreen clears the locked flag and resets the timer", () => {
    g.__jarelaScreenLock!.locked = true;
    const before = g.__jarelaScreenLock!.lastActivity;
    screenLock.unlockScreen();
    expect(g.__jarelaScreenLock!.locked).toBe(false);
    expect(g.__jarelaScreenLock!.lastActivity).toBeGreaterThanOrEqual(before);
  });

  it("lockScreen sets the locked flag", () => {
    screenLock.lockScreen();
    expect(screenLock.isScreenLocked()).toBe(true);
  });
});

describe("setIdleTimeoutMs", () => {
  it("updates the in-memory timeout and persists it", async () => {
    screenLock.setIdleTimeoutMs(123_000);
    expect(screenLock.getIdleTimeoutMs()).toBe(123_000);

    const appSettings = await import("@/lib/stores/app-settings");
    expect(appSettings.getScreenLockIdleTimeoutMs()).toBe(123_000);
  });

  it("rejects negative or non-finite values", () => {
    expect(() => screenLock.setIdleTimeoutMs(-1)).toThrow(/invalid timeout/);
    expect(() => screenLock.setIdleTimeoutMs(Number.NaN)).toThrow(/invalid timeout/);
    expect(() => screenLock.setIdleTimeoutMs(Infinity)).toThrow(/invalid timeout/);
  });
});
