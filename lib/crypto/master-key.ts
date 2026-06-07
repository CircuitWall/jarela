// Master key management for at-rest encryption (ADR-0005).
//
// The key is a 32-byte value used by lib/crypto/envelope.ts for AES-256-GCM.
// Primary storage is the host OS keychain via @napi-rs/keyring (its
// keytar-compatible shim). We bootstrap synchronously by spawning a
// one-shot child Node process so the rest of the codebase keeps its
// synchronous store API.
//
// Fallback (when keychain access fails — headless Linux, locked Mac
// keychain, missing keyring native binary): a 0600-permissioned file at
// ${dataDir}/.secret-key. Same threat model as today's plaintext DB for
// adversaries with filesystem read, but uniform so the encrypt/decrypt
// code path stays single-shape.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  InvalidPinError,
  isWrappedKeyfile,
  unwrapMasterKey,
  wrapMasterKey,
} from "./pin-wrap";

const KEYCHAIN_SERVICE = "jarela";
const KEYCHAIN_ACCOUNT = "master-key.v1";
const KEYFILE_NAME = ".secret-key";
const WRAPPED_KEYFILE_NAME = ".secret-key.enc";

export type MasterKeySource = "keychain" | "keyfile" | "pin-wrapped-keyfile";
export type MasterKeyState = "unlocked" | "locked";

export class MasterKeyLockedError extends Error {
  constructor() {
    super("master key is locked — call unlockMasterKey(pin) first");
    this.name = "MasterKeyLockedError";
  }
}

export { InvalidPinError };

let _key: Buffer | null = null;
let _source: MasterKeySource | null = null;
let _state: MasterKeyState | null = null;
let _dataDir: string | null = null;
const _unlockListeners: Array<() => void> = [];

// Synchronously read or generate the master key. Idempotent; only does
// real work on first call. Returns where the key ended up living so
// callers can warn the user about the keyfile fallback.
//
// Resolution order:
//   1. If ${dataDir}/.secret-key.enc exists, the key is PIN-wrapped
//      (ADR-0063). The blob is recorded but NOT decrypted; state
//      becomes "locked" and getMasterKey() throws MasterKeyLockedError
//      until unlockMasterKey(pin) is called. The DB bootstrap defers
//      runCryptoMigration() in this state.
//   2. If ${dataDir}/.secret-key exists, use it. The keyfile is
//      authoritative once present: the on-disk rows were encrypted
//      with that key, and silently switching to a different key
//      source would orphan them. To migrate to the keychain, decrypt
//      with the keyfile + re-encrypt + delete the keyfile (see
//      scripts/rekey-to-keychain.mjs — TODO).
//   3. Otherwise try the OS keychain via keytar (child process).
//   4. Otherwise generate a fresh keyfile and warn the user.
export function initMasterKey(dataDir: string): { source: MasterKeySource; state: MasterKeyState } {
  if (_source && _state) return { source: _source, state: _state };

  _dataDir = dataDir;
  const wrappedPath = join(dataDir, WRAPPED_KEYFILE_NAME);
  const path = join(dataDir, KEYFILE_NAME);

  // 1) PIN-wrapped keyfile — stay locked until unlockMasterKey() runs.
  if (existsSync(wrappedPath)) {
    const buf = readFileSync(wrappedPath);
    if (!isWrappedKeyfile(buf)) {
      throw new Error(`malformed wrapped keyfile at ${wrappedPath}`);
    }
    _source = "pin-wrapped-keyfile";
    _state = "locked";
    return { source: _source, state: _state };
  }

  // 2) Existing plaintext keyfile — authoritative.
  if (existsSync(path)) {
    _key = readFileSync(path);
    if (_key.length !== 32) throw new Error(`keyfile wrong length: ${_key.length}`);
    _source = "keyfile";
    _state = "unlocked";
    return { source: _source, state: _state };
  }

  // 3) Try keychain via a one-shot child process so we can stay sync.
  try {
    const keyB64 = loadOrCreateViaKeychain();
    _key = Buffer.from(keyB64, "base64");
    if (_key.length !== 32) throw new Error(`keychain key wrong length: ${_key.length}`);
    _source = "keychain";
    _state = "unlocked";
    return { source: _source, state: _state };
  } catch (err) {
    console.warn(
      `[jarela] keychain unavailable, falling back to keyfile: ${(err as Error).message}`,
    );
  }

  // 4) Fallback: generate a fresh keyfile.
  _key = randomBytes(32);
  writeFileSync(path, _key, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* */ }

  _source = "keyfile";
  _state = "unlocked";
  return { source: _source, state: _state };
}

export function getMasterKey(): Buffer {
  if (_state === "locked") {
    throw new MasterKeyLockedError();
  }
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

export function getMasterKeyState(): MasterKeyState | null {
  return _state;
}

export function isMasterKeyLocked(): boolean {
  return _state === "locked";
}

// Register a callback to run once the master key transitions from
// "locked" to "unlocked" (or runs immediately if already unlocked).
// Used by the DB layer to defer runCryptoMigration() and by background
// jobs that need to wait for the user's PIN before they can read state.
export function onMasterKeyUnlocked(cb: () => void): void {
  if (_state === "unlocked") {
    try { cb(); } catch (err) {
      console.warn("[jarela] onMasterKeyUnlocked callback threw:", err);
    }
    return;
  }
  _unlockListeners.push(cb);
}

// Decrypt the on-disk wrapped key with the supplied PIN. Throws
// MasterKeyLockedError if not in a locked state (nothing to unlock),
// InvalidPinError on wrong PIN. On success, the key lives in memory
// and getMasterKey() works again.
export function unlockMasterKey(pin: string): void {
  if (_state !== "locked") {
    throw new Error("master key is not locked");
  }
  if (!_dataDir) throw new Error("initMasterKey() must run before unlockMasterKey()");

  const wrappedPath = join(_dataDir, WRAPPED_KEYFILE_NAME);
  const buf = readFileSync(wrappedPath);
  const key = unwrapMasterKey(buf, pin);
  _key = key;
  _state = "unlocked";
  drainUnlockListeners();
}

function drainUnlockListeners(): void {
  const listeners = _unlockListeners.splice(0, _unlockListeners.length);
  for (const cb of listeners) {
    try { cb(); } catch (err) {
      console.warn("[jarela] onMasterKeyUnlocked callback threw:", err);
    }
  }
}

// Enable or change the PIN. Must be called while unlocked. If a wrapped
// keyfile already exists, currentPin is required and is verified by
// re-unwrapping the on-disk blob before the new wrap is written. The
// wrap is written atomically (tmp + rename) and the legacy plaintext
// keyfile / keychain entry is removed once the new wrap is in place.
export function setPin(args: { currentPin?: string; newPin: string }): void {
  if (_state !== "unlocked" || !_key) {
    throw new MasterKeyLockedError();
  }
  if (!_dataDir) throw new Error("initMasterKey() must run before setPin()");

  const wrappedPath = join(_dataDir, WRAPPED_KEYFILE_NAME);
  const keyfilePath = join(_dataDir, KEYFILE_NAME);

  if (_source === "pin-wrapped-keyfile") {
    // Change-PIN flow: verify the current PIN by unwrapping the blob.
    // Throws InvalidPinError if wrong — propagate to the route.
    if (!args.currentPin) throw new Error("currentPin is required when PIN is already set");
    const existing = readFileSync(wrappedPath);
    unwrapMasterKey(existing, args.currentPin);
  }

  const wrapped = wrapMasterKey(_key, args.newPin);
  const tmp = `${wrappedPath}.tmp`;
  writeFileSync(tmp, wrapped, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* */ }
  renameSync(tmp, wrappedPath);
  try { chmodSync(wrappedPath, 0o600); } catch { /* */ }

  // Drop the prior key material so the wrapped file is the only path in.
  if (_source === "keychain") {
    try { deleteFromKeychain(); } catch (err) {
      console.warn(`[jarela] setPin: failed to delete keychain entry: ${(err as Error).message}`);
    }
  }
  if (existsSync(keyfilePath)) {
    try { unlinkSync(keyfilePath); } catch (err) {
      console.warn(`[jarela] setPin: failed to remove legacy keyfile: ${(err as Error).message}`);
    }
  }

  _source = "pin-wrapped-keyfile";
}

// Disable the PIN: verify currentPin, restore the master key to the
// keychain (preferred) or plaintext keyfile, then delete the wrapped
// blob. Must be called while unlocked.
export function disablePin(currentPin: string): { source: MasterKeySource } {
  if (_state !== "unlocked" || !_key) {
    throw new MasterKeyLockedError();
  }
  if (_source !== "pin-wrapped-keyfile") {
    throw new Error("PIN is not enabled");
  }
  if (!_dataDir) throw new Error("initMasterKey() must run before disablePin()");

  const wrappedPath = join(_dataDir, WRAPPED_KEYFILE_NAME);
  const keyfilePath = join(_dataDir, KEYFILE_NAME);

  // Verify currentPin by unwrap — throws InvalidPinError on mismatch.
  const existing = readFileSync(wrappedPath);
  unwrapMasterKey(existing, currentPin);

  // Try to land back in the keychain; fall through to a plaintext
  // keyfile if the keychain is unavailable on this host.
  let nextSource: MasterKeySource = "keychain";
  try {
    writeToKeychain(_key.toString("base64"));
  } catch (err) {
    console.warn(
      `[jarela] disablePin: keychain unavailable, writing keyfile: ${(err as Error).message}`,
    );
    writeFileSync(keyfilePath, _key, { mode: 0o600 });
    try { chmodSync(keyfilePath, 0o600); } catch { /* */ }
    nextSource = "keyfile";
  }

  try { unlinkSync(wrappedPath); } catch (err) {
    console.warn(`[jarela] disablePin: failed to remove wrapped keyfile: ${(err as Error).message}`);
  }

  _source = nextSource;
  return { source: nextSource };
}

// Test-only: reset module state so each test gets a fresh init.
export function __resetMasterKeyForTests(): void {
  _key = null;
  _source = null;
  _state = null;
  _dataDir = null;
  _unlockListeners.length = 0;
}

// Spawn a child Node process that talks to the OS keyring and prints the
// base64 key on stdout. Either reads the existing entry or generates a
// new one and stores it. Synchronous from the caller's perspective.
function loadOrCreateViaKeychain(): string {
  const script = `
    const keytar = require('@napi-rs/keyring/keytar');
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

function writeToKeychain(keyB64: string): void {
  const script = `
    const keytar = require('@napi-rs/keyring/keytar');
    (async () => {
      const SERVICE = ${JSON.stringify(KEYCHAIN_SERVICE)};
      const ACCOUNT = ${JSON.stringify(KEYCHAIN_ACCOUNT)};
      await keytar.setPassword(SERVICE, ACCOUNT, process.argv[1]);
    })().catch((e) => {
      process.stderr.write(String(e && e.message ? e.message : e));
      process.exit(1);
    });
  `;
  execFileSync(process.execPath, ["-e", script, keyB64], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
}

function deleteFromKeychain(): void {
  const script = `
    const keytar = require('@napi-rs/keyring/keytar');
    (async () => {
      const SERVICE = ${JSON.stringify(KEYCHAIN_SERVICE)};
      const ACCOUNT = ${JSON.stringify(KEYCHAIN_ACCOUNT)};
      await keytar.deletePassword(SERVICE, ACCOUNT);
    })().catch((e) => {
      process.stderr.write(String(e && e.message ? e.message : e));
      process.exit(1);
    });
  `;
  execFileSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
}
