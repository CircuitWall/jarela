---
status: accepted
date: 2026-06-02
deciders: example-user, claude
---

# Client `request()` timeout + transient-status retry

## Context and Problem Statement

`api/client.ts#request()` is the chokepoint every component-side API call flows through. Until this PR it was a 9-line wrapper that:
- Issued `fetch()` with the caller's headers/body unchanged.
- Threw on non-2xx with a `new Error(\`${status} ${text}\`)`.
- Had no per-request timeout — a hung server blocked indefinitely.
- Had no retry logic — every transient blip (corp-proxy `ECONNRESET`, an upstream 503, a 502 from the load balancer) propagated to the caller as a thrown `Error` whose `.message` is the only signal of what went wrong.

Knock-on effects:
- The chat UI catches the throw and pushes an error toast saying "Couldn't load X" with the raw status text. Users get a banner asking them to retry; many of those failures would have succeeded on a single retry.
- Components have no way to distinguish "network glitch, just retry" from "server returned 400, fix your input" — the thrown `Error` is identity-less.
- Long-running requests (warm-summary background job poll, dashboard metrics refresh) have no upper bound.

PR-C's `provider-errors.ts` tackled the same problem at the agent stream layer; this PR ships the equivalent for the REST surface.

## Decision Drivers

* **Per-request timeout.** A hung server must not block a UI flow forever.
* **Auto-retry transients.** Network errors, 502/503/504, and (for safe methods only) 429 are recoverable; not retrying loses real successes.
* **Don't retry mutations on 429.** A POST that gets rate-limited by an upstream proxy may have actually landed; replaying could double-write.
* **Typed errors.** Existing `catch (err) { … err.message }` patterns must keep working; new branches that want to differentiate network/http/timeout get a typed shape.
* **Composable with existing AbortSignals.** Components already pass `signal: ctrl.signal` to cancel pending requests on unmount; the new timeout signal must compose with that, not override it.
* **Operator escape hatch.** Set `JARELA_DISABLE_CLIENT_RETRY=1` to disable retry entirely when debugging.

## Considered Options

* **(A) Status quo — caller deals.** Every component implements its own retry. Fragments inconsistently (most don't retry at all).
* **(B) `fetchretry`-style middleware library.** Imports a dep; over-engineered for our flat retry shape.
* **(C) Inline retry loop inside `request()` with typed `ApiRequestError`.** ~80 lines, no new deps, tested in isolation, easy to opt-out via env var.

## Decision Outcome

Chosen: **(C) Inline retry loop**.

`request()` now wraps each attempt in a per-attempt `AbortController` whose signal is composed with the caller's via `composeSignals()`. The 30s timeout signal aborts only that attempt; on retry, a fresh signal is allocated. The caller's signal aborts the whole chain (mid-attempt or between retries).

Retry policy:
- **Network failures** (TypeError "fetch failed", DNS errors, undici cause-chained failures): retry every method, up to 3 attempts.
- **HTTP 502/503/504**: retry every method, up to 3 attempts.
- **HTTP 429**: retry only safe methods (GET/HEAD), up to 3 attempts.
- **HTTP 4xx (except 429)**: never retry — the request is bad input or auth failure, replaying won't help.
- **Per-attempt timeout (30s)**: the failing attempt aborts; the loop counts that as a retryable failure unless we're on the last attempt, in which case throw `ApiRequestError("timeout", ...)`.
- **Caller-aborted**: never retry; rethrow as an `AbortError`-named `ApiRequestError("network")`.

Backoff schedule: 250ms → 1s → 4s. Pure exponential capped at 4s — keeps total worst-case latency at 5.25s + 30s timeout × 3 ≈ 95s before final failure. Acceptable; the alternative is hanging on a permanent failure.

`JARELA_DISABLE_CLIENT_RETRY=1` short-circuits to `maxAttempts = 1`. For ops debugging.

`ApiRequestError` carries `kind: "network" | "http" | "timeout"` plus optional `status: number`. Existing `catch (err) { setError(err.message) }` patterns unchanged; new code can branch on `err.kind` without parsing the message string.

### Consequences

* Good — every transient failure that previously surfaced as a sticky toast now self-heals on the second attempt.
* Good — components can differentiate failure classes via `err.kind` instead of regexing `err.message`.
* Good — `JARELA_DISABLE_CLIENT_RETRY` lets ops force the old behaviour for debugging.
* Good — the 30s wall-clock timeout bounds the worst-case "spinning forever" UI state (audited as a separate finding in the bloat audit).
* Good — composable with existing AbortControllers (component unmount still cancels in-flight requests cleanly).
* Bad — retried POSTs on network errors *could* double-write if the original landed but the response was lost. Mitigated by retrying POSTs only on network errors (not 429), where the chance of a successful landed-but-no-response is much lower than for 429s. Acceptable trade-off; the alternative (no retry) loses real failures more often.
* Bad — adds ~80 LOC to a previously-tiny helper. Tested in isolation via `ApiRequestError` shape tests + integrated through every existing API test that uses `request()` (none broken).

## Pros and Cons of the Options

### (C) Inline retry loop (chosen)

* Good — no new dep; targeted to exactly our surface.
* Good — typed errors via `ApiRequestError`; existing string-message catches unchanged.
* Good — `composeSignals()` keeps the caller's abort working alongside the timeout.
* Neutral — manual signal composition (no `AbortSignal.any()`) — portable across runtimes.

### (B) `fetchretry` library

* Good — battle-tested.
* Bad — adds a dep + we'd still need to define our error class for typed branching. Net zero.

### (A) Status quo

* Good — zero change.
* Bad — the failures we're losing today.

## Implementation notes

* `REQUEST_TIMEOUT_MS = 30_000`, `MAX_REQUEST_ATTEMPTS = 3`, `RETRY_BACKOFFS_MS = [250, 1_000, 4_000]`.
* `SAFE_METHODS = new Set(["GET", "HEAD"])` — only these retry on 429.
* `composeSignals(a, b)` creates a derived signal that aborts when either does. Manual implementation rather than `AbortSignal.any()` to stay compatible with older Node — the rest of the runtime supports it but the codebase has been conservative about that primitive.
* `ApiRequestError` is exported from `api/client.ts`. New consumers can `import { ApiRequestError } from "@/api/client"` and branch on `kind`. Existing consumers that catch generic `Error` keep working — `ApiRequestError` is an `Error` subclass.
* The retry loop's `finally` clears the per-attempt timeout handle even when the loop short-circuits via throw — no timer leaks.
* `JARELA_DISABLE_CLIENT_RETRY=1` checked via `process.env`. Browser bundles see `process` polyfilled by Next; the check is safe to run client-side and just returns false there.

## Cross-references

ADR-0049 / 0050 / 0051 (server-side error vocabulary the chat UI in PR-D will consume); PR-1's `withToolTimeout` (same pattern at the tool-invocation layer).
