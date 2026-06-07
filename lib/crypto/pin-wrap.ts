// PIN-wrapped keyfile format (ADR-0063 v1).
//
// Wraps the 32-byte at-rest master key with a Key Encryption Key (KEK)
// derived from a 6-digit PIN via scrypt. The wrapped blob is what gets
// written to `${JARELA_DB_DIR}/.secret-key.enc` when the user opts in
// from the Security panel.
//
// On-disk layout (90 bytes total, all numbers big-endian):
//
//   offset  bytes  field
//   0       1      version           // 0x01
//   1       1      kdf               // 0x01 = scrypt
//   2       4      kdf_log2_n        // scrypt cost (N = 2 ** kdf_log2_n)
//   6       4      kdf_r             // scrypt block size
//   10      4      kdf_p             // scrypt parallelism
//   14      16     kdf_salt
//   30      12     aes_nonce         // GCM nonce
//   42      32     wrapped_key       // AES-256-GCM(master_key, KEK)
//   74      16     auth_tag
//   90      <end>
//
// The KDF parameters are stored inline so v2 can tune them without a
// destructive migration: unwrap reads kdf_* out of the blob and feeds
// them straight to crypto.scrypt.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

const VERSION_V1 = 0x01;
const KDF_SCRYPT = 0x01;

// OWASP-recommended scrypt parameters for password storage (Cheat
// Sheet 2024): N=2^17 (~128 MiB working memory), r=8, p=1. Tuned to
// ~500 ms per derivation on a 2024 laptop; offline brute force of the
// 1 M 6-digit PIN keyspace runs into thousands of CPU-hours per attempt
// stream on commodity attacker hardware bottlenecked by memory bandwidth.
const SCRYPT_LOG2_N = 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEK_LENGTH = 32;

const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const MASTER_KEY_LENGTH = 32;

// scrypt's working-set memory is ~ 128 * r * N bytes. At N=2^17, r=8
// that's ~128 MiB, which exceeds Node's default 32 MiB maxmem cap.
// Set explicitly so the call doesn't reject with "memory limit exceeded".
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export const PIN_WRAPPED_KEYFILE_SIZE = 90;

export interface WrappedKeyfile {
  version: number;
  kdf: number;
  kdfLog2N: number;
  kdfR: number;
  kdfP: number;
  salt: Buffer;
  nonce: Buffer;
  wrappedKey: Buffer;
  tag: Buffer;
}

export function isWrappedKeyfile(buf: Buffer): boolean {
  return (
    buf.length === PIN_WRAPPED_KEYFILE_SIZE &&
    buf[0] === VERSION_V1 &&
    buf[1] === KDF_SCRYPT
  );
}

export function wrapMasterKey(masterKey: Buffer, pin: string): Buffer {
  if (masterKey.length !== MASTER_KEY_LENGTH) {
    throw new Error(`master key must be ${MASTER_KEY_LENGTH} bytes`);
  }
  assertValidPin(pin);

  const salt = randomBytes(SALT_LENGTH);
  const nonce = randomBytes(NONCE_LENGTH);
  const kek = deriveKek(pin, salt, SCRYPT_LOG2_N, SCRYPT_R, SCRYPT_P);

  const cipher = createCipheriv("aes-256-gcm", kek, nonce);
  const wrappedKey = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Zero the KEK as soon as we're done with it. Doesn't help against a
  // memory-dumping attacker (the master key itself is also in RAM once
  // unlocked) but reduces the window where two pieces of key material
  // sit alongside each other.
  kek.fill(0);

  return serialize({
    version: VERSION_V1,
    kdf: KDF_SCRYPT,
    kdfLog2N: SCRYPT_LOG2_N,
    kdfR: SCRYPT_R,
    kdfP: SCRYPT_P,
    salt,
    nonce,
    wrappedKey,
    tag,
  });
}

// Throws `InvalidPinError` on bad PIN (the AES-GCM auth tag is what
// fails — there is no separate verifier, the tag IS the verifier).
// Throws other errors for malformed blob, unsupported version, etc.
export function unwrapMasterKey(buf: Buffer, pin: string): Buffer {
  assertValidPin(pin);
  const parsed = parse(buf);

  const kek = deriveKek(pin, parsed.salt, parsed.kdfLog2N, parsed.kdfR, parsed.kdfP);

  try {
    const decipher = createDecipheriv("aes-256-gcm", kek, parsed.nonce);
    decipher.setAuthTag(parsed.tag);
    const masterKey = Buffer.concat([
      decipher.update(parsed.wrappedKey),
      decipher.final(),
    ]);
    if (masterKey.length !== MASTER_KEY_LENGTH) {
      // Defensive — AES-GCM with a 32-byte input always yields 32 bytes,
      // but if the blob was crafted with a different wrappedKey length
      // this is the line that catches it.
      throw new Error(`unwrapped key wrong length: ${masterKey.length}`);
    }
    return masterKey;
  } catch (err) {
    // GCM auth-tag mismatch surfaces as an "Unsupported state or unable
    // to authenticate data" error. Normalize to a typed error the
    // unlock route can map to HTTP 401 (wrong PIN) vs HTTP 500 (broken
    // blob, file corruption, etc.).
    const msg = err instanceof Error ? err.message : String(err);
    if (/authenticate|state|tag/i.test(msg)) {
      throw new InvalidPinError();
    }
    throw err;
  } finally {
    kek.fill(0);
  }
}

export class InvalidPinError extends Error {
  constructor() {
    super("invalid PIN");
    this.name = "InvalidPinError";
  }
}

// 6 ASCII digits. Anything else throws before we burn the ~500 ms scrypt
// cost on input that can't possibly be valid.
function assertValidPin(pin: string): void {
  if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) {
    throw new Error("PIN must be exactly 6 digits");
  }
}

function deriveKek(pin: string, salt: Buffer, log2N: number, r: number, p: number): Buffer {
  const n = 1 << log2N;
  return scryptSync(pin, salt, KEK_LENGTH, { N: n, r, p, maxmem: SCRYPT_MAXMEM });
}

function serialize(w: WrappedKeyfile): Buffer {
  const out = Buffer.alloc(PIN_WRAPPED_KEYFILE_SIZE);
  out[0] = w.version;
  out[1] = w.kdf;
  out.writeUInt32BE(w.kdfLog2N, 2);
  out.writeUInt32BE(w.kdfR, 6);
  out.writeUInt32BE(w.kdfP, 10);
  w.salt.copy(out, 14);
  w.nonce.copy(out, 30);
  w.wrappedKey.copy(out, 42);
  w.tag.copy(out, 74);
  return out;
}

function parse(buf: Buffer): WrappedKeyfile {
  if (buf.length !== PIN_WRAPPED_KEYFILE_SIZE) {
    throw new Error(`wrapped keyfile wrong size: ${buf.length}`);
  }
  if (buf[0] !== VERSION_V1) {
    throw new Error(`unsupported wrapped keyfile version: 0x${buf[0].toString(16)}`);
  }
  if (buf[1] !== KDF_SCRYPT) {
    throw new Error(`unsupported KDF id: 0x${buf[1].toString(16)}`);
  }
  return {
    version: buf[0],
    kdf: buf[1],
    kdfLog2N: buf.readUInt32BE(2),
    kdfR: buf.readUInt32BE(6),
    kdfP: buf.readUInt32BE(10),
    salt: buf.subarray(14, 30),
    nonce: buf.subarray(30, 42),
    wrappedKey: buf.subarray(42, 74),
    tag: buf.subarray(74, 90),
  };
}
