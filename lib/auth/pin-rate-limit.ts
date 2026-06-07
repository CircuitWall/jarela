// Per-IP exponential backoff for PIN entry (ADR-0063).
//
// Stops a remote (loopback-rebinding / browser-extension) attacker from
// brute-forcing the 1 M-key PIN space at HTTP speed. Local UX cost is
// minimal: the splash UI lets a real user type at human speed, and the
// limiter only kicks in after 3 wrong tries.
//
// Backoff schedule (per remote): 3 free attempts, then 30s → 60s → 2m →
// 4m → 5m cap.

const FREE_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;

interface Entry {
  failures: number;
  blockedUntil: number;
}

const _state = new Map<string, Entry>();

export function checkPinRateLimit(remote: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const entry = _state.get(remote);
  if (!entry) return { allowed: true };
  const now = Date.now();
  if (entry.blockedUntil > now) {
    return { allowed: false, retryAfterMs: entry.blockedUntil - now };
  }
  return { allowed: true };
}

export function recordPinFailure(remote: string): void {
  const entry = _state.get(remote) ?? { failures: 0, blockedUntil: 0 };
  entry.failures += 1;
  if (entry.failures > FREE_ATTEMPTS) {
    const over = entry.failures - FREE_ATTEMPTS - 1;
    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** over, MAX_BACKOFF_MS);
    entry.blockedUntil = Date.now() + backoff;
  }
  _state.set(remote, entry);
}

export function recordPinSuccess(remote: string): void {
  _state.delete(remote);
}

// Test-only.
export function __resetPinRateLimitForTests(): void {
  _state.clear();
}
