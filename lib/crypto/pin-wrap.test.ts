import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  InvalidPinError,
  PIN_WRAPPED_KEYFILE_SIZE,
  isWrappedKeyfile,
  unwrapMasterKey,
  wrapMasterKey,
} from "./pin-wrap";

describe("pin-wrap", () => {
  it("wraps and unwraps a 32-byte master key", () => {
    const master = randomBytes(32);
    const wrapped = wrapMasterKey(master, "123456");

    expect(wrapped.length).toBe(PIN_WRAPPED_KEYFILE_SIZE);
    expect(isWrappedKeyfile(wrapped)).toBe(true);

    const unwrapped = unwrapMasterKey(wrapped, "123456");
    expect(unwrapped.equals(master)).toBe(true);
  });

  it("produces a different ciphertext every call (random salt + nonce)", () => {
    const master = randomBytes(32);
    const a = wrapMasterKey(master, "654321");
    const b = wrapMasterKey(master, "654321");
    expect(a.equals(b)).toBe(false);
  });

  it("throws InvalidPinError on wrong PIN", () => {
    const wrapped = wrapMasterKey(randomBytes(32), "111111");
    expect(() => unwrapMasterKey(wrapped, "222222")).toThrow(InvalidPinError);
  });

  it("rejects non-6-digit PINs at wrap time", () => {
    const master = randomBytes(32);
    expect(() => wrapMasterKey(master, "1234")).toThrow(/6 digits/);
    expect(() => wrapMasterKey(master, "12345a")).toThrow(/6 digits/);
    expect(() => wrapMasterKey(master, "1234567")).toThrow(/6 digits/);
    expect(() => wrapMasterKey(master, "")).toThrow(/6 digits/);
  });

  it("rejects non-6-digit PINs at unwrap time", () => {
    const wrapped = wrapMasterKey(randomBytes(32), "987654");
    expect(() => unwrapMasterKey(wrapped, "")).toThrow(/6 digits/);
    expect(() => unwrapMasterKey(wrapped, "987")).toThrow(/6 digits/);
  });

  it("rejects a wrong-sized blob with a clear error", () => {
    expect(() => unwrapMasterKey(Buffer.alloc(50), "123456")).toThrow(/wrong size/);
  });

  it("rejects an unknown version byte", () => {
    const wrapped = wrapMasterKey(randomBytes(32), "555555");
    wrapped[0] = 0x99;
    expect(() => unwrapMasterKey(wrapped, "555555")).toThrow(/version/);
  });

  it("rejects an unknown KDF id", () => {
    const wrapped = wrapMasterKey(randomBytes(32), "555555");
    wrapped[1] = 0x99;
    expect(() => unwrapMasterKey(wrapped, "555555")).toThrow(/KDF/);
  });

  it("isWrappedKeyfile rejects buffers that are not v1 scrypt blobs", () => {
    expect(isWrappedKeyfile(Buffer.alloc(32))).toBe(false);
    expect(isWrappedKeyfile(Buffer.alloc(PIN_WRAPPED_KEYFILE_SIZE))).toBe(false);
    expect(isWrappedKeyfile(randomBytes(PIN_WRAPPED_KEYFILE_SIZE))).toBe(false);
  });

  it("a corrupted auth tag surfaces as InvalidPinError, not a low-level crypto error", () => {
    // Treat any AES-GCM authentication failure as "bad PIN" so the
    // HTTP layer doesn't leak whether the file was tampered with vs
    // the user typed the wrong code.
    const wrapped = wrapMasterKey(randomBytes(32), "100000");
    wrapped[wrapped.length - 1] ^= 0xff;
    expect(() => unwrapMasterKey(wrapped, "100000")).toThrow(InvalidPinError);
  });
});
