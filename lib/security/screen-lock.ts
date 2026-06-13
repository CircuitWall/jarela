/**
 * Screen-lock state for the running app process.
 *
 * Distinct from the master-key lock (lib/crypto/master-key.ts):
 *
 *   - Master-key lock = crypto lock. Key wiped from memory; decryption
 *     throws; background work stalls until PIN unwraps the keyfile.
 *
 *   - Screen lock = presence lock. The master key stays in memory so
 *     scheduled tasks, bridges, and streaming runs keep going. The UI
 *     is hidden behind a PIN re-prompt that just verifies the user
 *     entered the same PIN that wraps their keyfile — a "is the human
 *     still here?" check, not a re-derivation of the key.
 *
 * Triggered by inactivity: the proxy records every non-polling /api/v1/*
 * request as user activity. After `idleTimeoutMs` of silence the next
 * request flips the screen-locked flag and gets a 423.
 *
 * Pinned to globalThis to survive Next.js dev bundle isolation (each
 * route handler / proxy file gets its own ESM instance — bare module-
 * level `let`s wouldn't share state). Same pattern as master-key.ts.
 */

import {
  getScreenLockIdleTimeoutMs,
  setScreenLockIdleTimeoutMs,
} from "@/lib/stores/app-settings";

const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

type ScreenLockGlobals = {
  lastActivity: number;
  idleTimeoutMs: number;
  locked: boolean;
  hydrated: boolean;
};

const _host = globalThis as unknown as {
  __jarelaScreenLock?: ScreenLockGlobals;
};
const _g: ScreenLockGlobals =
  _host.__jarelaScreenLock ??
  (_host.__jarelaScreenLock = {
    lastActivity: Date.now(),
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    locked: false,
    hydrated: false,
  });

// Pull the user-configured timeout off disk the first time we're asked
// after a process start. Done lazily so importing this module doesn't
// force a DB open before initMasterKey() has run.
function hydrateOnce(): void {
  if (_g.hydrated) return;
  try {
    const persisted = getScreenLockIdleTimeoutMs();
    if (persisted !== null) _g.idleTimeoutMs = persisted;
    _g.hydrated = true;
  } catch (err) {
    // DB not ready yet (first request before initMasterKey ran). Leave
    // the default and try again on the next call — don't flip hydrated.
    console.warn("[screen-lock] could not hydrate idle timeout:", err);
  }
}

/**
 * Record a user-initiated HTTP request. Resets the idle timer and (if
 * the screen was locked passively) does NOT unlock it — only an explicit
 * verify-pin call may clear the lock.
 */
export function recordUserActivity(): void {
  if (!_g.locked) {
    _g.lastActivity = Date.now();
  }
}

/**
 * Returns true if the screen should be considered locked right now.
 * Lazily flips the flag when the idle timeout has elapsed so we don't
 * need a background timer.
 */
export function isScreenLocked(): boolean {
  hydrateOnce();
  if (_g.locked) return true;
  if (_g.idleTimeoutMs <= 0) return false; // disabled
  if (Date.now() - _g.lastActivity > _g.idleTimeoutMs) {
    _g.locked = true;
    return true;
  }
  return false;
}

/** Unlock — called after a successful verify-pin. */
export function unlockScreen(): void {
  _g.locked = false;
  _g.lastActivity = Date.now();
}

/** Force-lock immediately. Used by manual "lock now" actions. */
export function lockScreen(): void {
  _g.locked = true;
}

export function getIdleTimeoutMs(): number {
  hydrateOnce();
  return _g.idleTimeoutMs;
}

/** 0 disables the auto-lock entirely. */
export function setIdleTimeoutMs(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) throw new Error("invalid timeout");
  _g.idleTimeoutMs = Math.floor(ms);
  _g.lastActivity = Date.now();
  _g.hydrated = true; // we just set it; skip the load-from-disk path
  try {
    setScreenLockIdleTimeoutMs(_g.idleTimeoutMs);
  } catch (err) {
    console.warn("[screen-lock] could not persist idle timeout:", err);
  }
}
