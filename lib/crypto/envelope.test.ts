import { describe, it, expect, vi } from "vitest";

// Pin a deterministic 32-byte master key for the test process — avoids
// touching the real keychain / keyfile.
vi.mock("./master-key", () => {
  const key = Buffer.alloc(32, 7); // 32 bytes of 0x07
  return {
    getMasterKey: () => key,
    initMasterKey: () => ({ source: "keyfile" as const }),
    getMasterKeySource: () => "keyfile" as const,
  };
});

import {
  encrypt,
  decrypt,
  isEncrypted,
  decryptIfNeeded,
} from "./envelope";

describe("isEncrypted", () => {
  it("returns true for the enc:v1: prefix", () => {
    expect(isEncrypted("enc:v1:abc")).toBe(true);
  });
  it("returns false for plaintext", () => {
    expect(isEncrypted("plain")).toBe(false);
    expect(isEncrypted("")).toBe(false);
    expect(isEncrypted("enc:v0:abc")).toBe(false);
  });
});

describe("encrypt + decrypt round trip", () => {
  it("decrypts what it encrypted", () => {
    const ciphertext = encrypt("hello world");
    expect(isEncrypted(ciphertext)).toBe(true);
    expect(decrypt(ciphertext)).toBe("hello world");
  });

  it("round-trips multibyte unicode losslessly", () => {
    const s = "héllo 🌍 — résumé";
    expect(decrypt(encrypt(s))).toBe(s);
  });

  it("round-trips the empty string", () => {
    expect(decrypt(encrypt(""))).toBe("");
  });

  it("produces a different ciphertext each call (random IV)", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });
});

describe("decrypt error handling", () => {
  it("throws when called on a non-encrypted value", () => {
    expect(() => decrypt("plaintext")).toThrow(/non-encrypted/);
  });

  it("throws when the payload is too short to contain iv+tag", () => {
    expect(() => decrypt("enc:v1:" + Buffer.from([1, 2, 3]).toString("base64url"))).toThrow(
      /too short/,
    );
  });

  it("throws on a tampered tag (auth failure)", () => {
    const ct = encrypt("guarded");
    // Mutate one byte in the authenticated payload so GCM tag validation
    // deterministically fails after decoding.
    const prefix = "enc:v1:";
    const buf = Buffer.from(ct.slice(prefix.length), "base64url");
    buf[buf.length - 1] ^= 0x01;
    const tampered = prefix + buf.toString("base64url");
    expect(() => decrypt(tampered)).toThrow();
  });
});

describe("decryptIfNeeded", () => {
  it("returns plaintext unchanged", () => {
    expect(decryptIfNeeded("legacy plaintext")).toBe("legacy plaintext");
  });
  it("decrypts an encrypted value", () => {
    expect(decryptIfNeeded(encrypt("v"))).toBe("v");
  });
});
