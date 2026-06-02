// SQLITE_BUSY retry helper.
//
// WAL mode (enabled in lib/db/index.ts) makes concurrent reads + a single
// writer the common case, so SQLITE_BUSY is rare. It can still happen when:
//  - two requests land at the literal same instant and both want to write
//  - an external tool (sqlite3 CLI, DB browser) holds a lock
//  - the journal mode briefly transitions between WAL and rollback
//
// Wrapping a write helper in `withSqliteRetry` retries up to 3 times with
// 50ms / 100ms / 200ms backoff. After that, the original error propagates.
// Non-BUSY errors are rethrown immediately.
//
// This is a thin synchronous helper — better-sqlite3 and node:sqlite are
// both synchronous; the caller's code path stays synchronous too.
//
// See ADR-0053.

const BUSY_BACKOFFS_MS = [50, 100, 200];

/**
 * Run a synchronous database operation with SQLITE_BUSY retry. The fn is
 * invoked up to 4 times (3 retries on BUSY); other errors bypass the loop.
 *
 * Note: this is a synchronous helper using setTimeout-free busy-waiting.
 * The `Atomics.wait` approach used in the previous attempt at this helper
 * required SharedArrayBuffer which the runtime doesn't have set up. Instead
 * we busy-loop briefly — the contention window we're worried about is sub-
 * millisecond, so this is fine in practice.
 */
export function withSqliteRetry<T>(fn: () => T): T {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= BUSY_BACKOFFS_MS.length; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      if (!isBusyError(err)) throw err;
      lastErr = err;
      if (attempt === BUSY_BACKOFFS_MS.length) break;
      busyWait(BUSY_BACKOFFS_MS[attempt]);
    }
  }
  throw lastErr;
}

/**
 * True when an error is SQLITE_BUSY or SQLITE_LOCKED. Both indicate
 * "another writer holds the lock; try again" and are safe to retry on.
 * Other SQLITE_* errors (CORRUPT, IOERR, READONLY) are not retried — the
 * caller surfaces them.
 */
export function isBusyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  if (typeof e.code === "string" && (e.code === "SQLITE_BUSY" || e.code === "SQLITE_LOCKED")) {
    return true;
  }
  // node:sqlite surfaces these as messages without a code field.
  if (typeof e.message === "string" && /SQLITE_(?:BUSY|LOCKED)\b/.test(e.message)) return true;
  return false;
}

// Synchronous busy-wait. Better than nothing for sub-ms contention windows.
// We accept the wasted CPU because the alternative (setTimeout + Promise)
// would force every store helper to become async and cascade through the
// codebase. The retry budget caps total burn at ~350ms worst case.
function busyWait(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // intentionally empty — block briefly
  }
}
