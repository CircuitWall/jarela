import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These tests exercise the on-disk surface only — they avoid the OS
// keychain path by pre-seeding a `.secret-key` plaintext keyfile so
// initMasterKey() resolves at step 2 in its precedence ladder. The
// keychain branch is exercised end-to-end by the live test runner.
import {
  initMasterKey,
  getMasterKey,
  getMasterKeyState,
  isMasterKeyLocked,
  unlockMasterKey,
  setPin,
  disablePin,
  __resetMasterKeyForTests,
  MasterKeyLockedError,
  InvalidPinError,
} from "./master-key";
import { wrapMasterKey, PIN_WRAPPED_KEYFILE_SIZE } from "./pin-wrap";

const KEYFILE = ".secret-key";
const WRAPPED = ".secret-key.enc";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarela-mk-"));
  __resetMasterKeyForTests();
});

afterEach(() => {
  __resetMasterKeyForTests();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

describe("initMasterKey — plaintext keyfile path", () => {
  it("loads an existing 32-byte keyfile as unlocked", () => {
    const key = Buffer.alloc(32, 0xab);
    writeFileSync(join(dir, KEYFILE), key);

    const r = initMasterKey(dir);

    expect(r.source).toBe("keyfile");
    expect(r.state).toBe("unlocked");
    expect(getMasterKey().equals(key)).toBe(true);
  });

  it("is idempotent across calls", () => {
    const key = Buffer.alloc(32, 0xcd);
    writeFileSync(join(dir, KEYFILE), key);

    const a = initMasterKey(dir);
    const b = initMasterKey(dir);
    expect(a).toEqual(b);
  });
});

describe("initMasterKey — pin-wrapped keyfile path (ADR-0063)", () => {
  it("detects .secret-key.enc and stays locked", () => {
    const key = Buffer.alloc(32, 0xee);
    writeFileSync(join(dir, WRAPPED), wrapMasterKey(key, "123456"));

    const r = initMasterKey(dir);

    expect(r.source).toBe("pin-wrapped-keyfile");
    expect(r.state).toBe("locked");
    expect(isMasterKeyLocked()).toBe(true);
    expect(getMasterKeyState()).toBe("locked");
  });

  it("getMasterKey() throws MasterKeyLockedError while locked", () => {
    const key = Buffer.alloc(32, 0xee);
    writeFileSync(join(dir, WRAPPED), wrapMasterKey(key, "123456"));
    initMasterKey(dir);

    expect(() => getMasterKey()).toThrow(MasterKeyLockedError);
  });

  it("rejects malformed wrapped keyfiles at boot", () => {
    writeFileSync(join(dir, WRAPPED), Buffer.alloc(10, 0));
    expect(() => initMasterKey(dir)).toThrow(/malformed wrapped keyfile/);
  });
});

describe("unlockMasterKey", () => {
  it("decrypts the wrapped key and transitions to unlocked", () => {
    const key = Buffer.alloc(32, 0x11);
    writeFileSync(join(dir, WRAPPED), wrapMasterKey(key, "987654"));
    initMasterKey(dir);

    unlockMasterKey("987654");

    expect(isMasterKeyLocked()).toBe(false);
    expect(getMasterKey().equals(key)).toBe(true);
  });

  it("throws InvalidPinError on wrong PIN and stays locked", () => {
    const key = Buffer.alloc(32, 0x11);
    writeFileSync(join(dir, WRAPPED), wrapMasterKey(key, "987654"));
    initMasterKey(dir);

    expect(() => unlockMasterKey("000000")).toThrow(InvalidPinError);
    expect(isMasterKeyLocked()).toBe(true);
  });

  it("throws when not in a locked state (nothing to unlock)", () => {
    const key = Buffer.alloc(32, 0x22);
    writeFileSync(join(dir, KEYFILE), key);
    initMasterKey(dir);

    expect(() => unlockMasterKey("123456")).toThrow(/not locked/);
  });
});

describe("setPin — enable from plaintext keyfile", () => {
  it("wraps the existing key, deletes the plaintext keyfile, and switches source", () => {
    const key = Buffer.alloc(32, 0x33);
    writeFileSync(join(dir, KEYFILE), key);
    initMasterKey(dir);

    setPin({ newPin: "424242" });

    const wrappedPath = join(dir, WRAPPED);
    expect(existsSync(wrappedPath)).toBe(true);
    expect(readFileSync(wrappedPath).length).toBe(PIN_WRAPPED_KEYFILE_SIZE);
    expect(existsSync(join(dir, KEYFILE))).toBe(false);
    // Key is still in memory — current process stays unlocked.
    expect(getMasterKey().equals(key)).toBe(true);
  });
});

describe("setPin — change", () => {
  it("verifies currentPin and rewraps with the new PIN", () => {
    const key = Buffer.alloc(32, 0x44);
    writeFileSync(join(dir, WRAPPED), wrapMasterKey(key, "111111"));
    initMasterKey(dir);
    unlockMasterKey("111111");

    setPin({ currentPin: "111111", newPin: "222222" });

    // Reset and re-init from disk to prove the new PIN actually wraps.
    __resetMasterKeyForTests();
    initMasterKey(dir);
    expect(() => unlockMasterKey("111111")).toThrow(InvalidPinError);
    unlockMasterKey("222222");
    expect(getMasterKey().equals(key)).toBe(true);
  });

  it("rejects wrong currentPin without rewrapping", () => {
    const key = Buffer.alloc(32, 0x55);
    const original = wrapMasterKey(key, "111111");
    writeFileSync(join(dir, WRAPPED), original);
    initMasterKey(dir);
    unlockMasterKey("111111");

    expect(() => setPin({ currentPin: "000000", newPin: "333333" })).toThrow(InvalidPinError);

    // On-disk blob is untouched (still unwraps with the original PIN).
    expect(readFileSync(join(dir, WRAPPED)).equals(original)).toBe(true);
  });
});

describe("disablePin", () => {
  it("verifies currentPin, deletes wrapped keyfile, falls back to plaintext when keychain fails", () => {
    const key = Buffer.alloc(32, 0x66);
    writeFileSync(join(dir, WRAPPED), wrapMasterKey(key, "654321"));
    initMasterKey(dir);
    unlockMasterKey("654321");

    // In the test process the keychain child-process call is allowed to
    // fail; disablePin must transparently fall back to the plaintext
    // keyfile so the user is never locked out of their own data.
    const r = disablePin("654321");

    expect(r.source === "keychain" || r.source === "keyfile").toBe(true);
    expect(existsSync(join(dir, WRAPPED))).toBe(false);
    if (r.source === "keyfile") {
      expect(readFileSync(join(dir, KEYFILE)).equals(key)).toBe(true);
    }
  });

  it("rejects wrong currentPin", () => {
    const key = Buffer.alloc(32, 0x77);
    writeFileSync(join(dir, WRAPPED), wrapMasterKey(key, "654321"));
    initMasterKey(dir);
    unlockMasterKey("654321");

    expect(() => disablePin("000000")).toThrow(InvalidPinError);
    expect(existsSync(join(dir, WRAPPED))).toBe(true);
  });
});
