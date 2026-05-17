// Master key management for at-rest encryption (ADR-0005).
//
// The key is a 32-byte value used by lib/crypto/envelope.ts for AES-256-GCM.
// Primary storage is the host OS keychain via keytar. We bootstrap
// synchronously by spawning a one-shot child Node process so the rest of
// the codebase keeps its synchronous store API.
//
// Fallback (when keychain access fails — headless Linux, locked Mac
// keychain, missing keytar native binary): a 0600-permissioned file at
// ${dataDir}/.secret-key. Same threat model as today's plaintext DB for
// adversaries with filesystem read, but uniform so the encrypt/decrypt
// code path stays single-shape.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const KEYCHAIN_SERVICE = "jarela";
const KEYCHAIN_ACCOUNT = "master-key.v1";
const KEYFILE_NAME = ".secret-key";

export type MasterKeySource = "keychain" | "keyfile";

let _key: Buffer | null = null;
let _source: MasterKeySource | null = null;

// Synchronously read or generate the master key. Idempotent; only does
// real work on first call. Returns where the key ended up living so
// callers can warn the user about the keyfile fallback.
//
// Resolution order:
//   1. If ${dataDir}/.secret-key exists, use it. The keyfile is
//      authoritative once present: the on-disk rows were encrypted
//      with that key, and silently switching to a different key
//      source would orphan them. To migrate to the keychain, decrypt
//      with the keyfile + re-encrypt + delete the keyfile (see
//      scripts/rekey-to-keychain.mjs — TODO).
//   2. Otherwise try the OS keychain via keytar (child process).
//   3. Otherwise generate a fresh keyfile and warn the user.
export function initMasterKey(dataDir: string): { source: MasterKeySource } {
  if (_key && _source) return { source: _source };

  const path = join(dataDir, KEYFILE_NAME);

  // 1) Existing keyfile — authoritative.
  if (existsSync(path)) {
    _key = readFileSync(path);
    if (_key.length !== 32) throw new Error(`keyfile wrong length: ${_key.length}`);
    _source = "keyfile";
    return { source: "keyfile" };
  }

  // 2) Try keychain via a one-shot child process so we can stay sync.
  try {
    const keyB64 = loadOrCreateViaKeychain();
    _key = Buffer.from(keyB64, "base64");
    if (_key.length !== 32) throw new Error(`keychain key wrong length: ${_key.length}`);
    _source = "keychain";
    return { source: "keychain" };
  } catch (err) {
    console.warn(
      `[jarela] keychain unavailable, falling back to keyfile: ${(err as Error).message}`,
    );
  }

  // 3) Fallback: generate a fresh keyfile.
  _key = randomBytes(32);
  writeFileSync(path, _key, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* */ }

  _source = "keyfile";
  return { source: "keyfile" };
}

export function getMasterKey(): Buffer {
  if (!_key) {
    throw new Error(
      "master key not initialized — initMasterKey() must run before any encrypted store access",
    );
  }
  return _key;
}

export function getMasterKeySource(): MasterKeySource | null {
  return _source;
}

// Spawn a child Node process that talks to keytar and prints the base64
// key on stdout. Either reads the existing entry or generates a new one
// and stores it. Synchronous from the caller's perspective.
function loadOrCreateViaKeychain(): string {
  const script = `
    const keytar = require('keytar');
    const { randomBytes } = require('crypto');
    (async () => {
      const SERVICE = ${JSON.stringify(KEYCHAIN_SERVICE)};
      const ACCOUNT = ${JSON.stringify(KEYCHAIN_ACCOUNT)};
      let v = await keytar.getPassword(SERVICE, ACCOUNT);
      if (!v) {
        v = randomBytes(32).toString('base64');
        await keytar.setPassword(SERVICE, ACCOUNT, v);
      }
      process.stdout.write(v);
    })().catch((e) => {
      process.stderr.write(String(e && e.message ? e.message : e));
      process.exit(1);
    });
  `;
  const out = execFileSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    // Cap at 10s in case keytar hangs (e.g. macOS prompt with no user).
    timeout: 10_000,
  });
  return out.trim();
}
