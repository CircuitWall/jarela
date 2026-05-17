// AES-256-GCM envelope for at-rest secret storage (ADR-0005).
//
// Wire format: `enc:v1:<base64url(iv ‖ ciphertext ‖ tag)>`
//   - iv:         12 bytes (random per value)
//   - ciphertext: variable
//   - tag:        16 bytes (GCM auth tag)
//
// The `enc:v1:` prefix is the on-disk marker for "this value is encrypted
// under the current scheme". `decryptIfNeeded` returns plaintext for
// either prefixed or legacy unprefixed values, so a partially-migrated
// DB keeps working.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getMasterKey } from "./master-key";

const PREFIX = "enc:v1:";
const IV_LEN = 12;
const TAG_LEN = 16;

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encrypt(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, ct, tag]).toString("base64url");
}

export function decrypt(envelope: string): string {
  if (!isEncrypted(envelope)) {
    throw new Error("decrypt() called on non-encrypted value");
  }
  const buf = Buffer.from(envelope.slice(PREFIX.length), "base64url");
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error(`encrypted payload too short: ${buf.length} bytes`);
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const key = getMasterKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

// Idempotent read-side helper. Plaintext (legacy) passes through; an
// encrypted value is decrypted; an unparseable encrypted value throws.
export function decryptIfNeeded(value: string): string {
  return isEncrypted(value) ? decrypt(value) : value;
}

// Idempotent write-side helper. An already-encrypted value passes
// through unchanged, which keeps the eager migration safe to re-run.
export function encryptIfNeeded(value: string): string {
  return isEncrypted(value) ? value : encrypt(value);
}
