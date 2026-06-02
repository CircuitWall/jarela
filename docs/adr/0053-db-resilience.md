---
status: accepted
date: 2026-06-02
deciders: andwu, claude
---

# Database resilience: SQLITE_BUSY retry, constraint translation, migration safety, error envelope code

## Context and Problem Statement

The audit on long-task reliability surfaced four DB-layer pain points:

1. **No SQLITE_BUSY retry.** WAL mode (set in `lib/db/index.ts:27`) makes lock contention rare but not impossible. When a second writer hits a literal-same-instant lock, the request fails with raw SQLite text. No retry, no graceful degradation.

2. **UNIQUE / FOREIGN KEY violations leak as raw SQLite messages.** Stores throw on duplicate inserts (`createThread` for an agent that already has a thread) and the API returns `"SQLITE_CONSTRAINT: UNIQUE constraint failed: threads.agent_id"` to the client. This leaks the schema and reads like a bug instead of "you tried to do X but Y already exists, here's how to fix it."

3. **Migration failure during boot crashes the process silently.** `runMigrations` is invoked synchronously inside `getDb()`. If it throws (corrupted DB, schema regression after a downgrade), the error bubbles out of every subsequent request as a stack trace — the user sees that on EVERY request because `_db` is never assigned and we re-enter the failing branch.

4. **API error envelope has no `code` field.** The client receives `{error: "..."}` and has to regex the message string to differentiate "thread already exists" from "thread doesn't exist" from "validation failure". Same problem we already fixed for tools (ADR-0049/0050) and providers (ADR-0051), now for the REST surface.

## Decision Drivers

* **Retry the small contention windows.** SQLITE_BUSY is the canonical "try again" signal; not retrying is choosing to lose calls that would succeed on the second attempt.
* **Translate at the lowest layer that has context.** `domainErrorFor()` runs at the store layer where we know which table/column triggered the constraint; the API route just maps the typed error to a 409 + code.
* **Don't make every store async.** SQLite is synchronous. The retry helper has to stay synchronous to avoid cascading async through every store helper.
* **Migration failure must be loud + actionable.** A boot-time failure that loops on every request is the worst possible UX; surface a clear "back up the DB and rename it" message.
* **Add `code` to the API error envelope.** Every other layer of the system now speaks codes; the REST layer must too.

## Considered Options

### SQLITE_BUSY retry placement

* **(A) Wrap every store helper individually.** Tedious but explicit.
* **(B) Wrap inside `getDb()` so every prepare/run goes through retry.** Can't easily — node:sqlite's prepared statements are tightly coupled to the database handle.
* **(C) Provide a `withSqliteRetry(fn)` helper that store helpers can opt into.** Same shape as `withToolTimeout` (PR-1) and `summarizeTranscriptWithRetry` (PR-2). Minimal cascade, callers pick coverage.

### Constraint error translation

* **(α) Inline translation at every store helper.** Duplicated logic.
* **(β) Shared `domainErrorFor(err)` helper that returns either a typed `DomainConstraintError` or the original error unchanged.** Tested in isolation; stores call once at the catch site.

### Migration failure

* **(i) Let it crash silently as today.** Status quo.
* **(ii) Catch + close DB + throw a friendly error naming the path and recovery.**

### Error envelope `code`

* **(I) Skip — REST callers don't need codes.** Status quo.
* **(II) Add optional `code` parameter to `errorResponse()`.** Backward-compatible: existing one-arg callers unchanged; new callers (this PR + future) emit codes.

## Decision Outcome

Chosen: **(C) `withSqliteRetry` helper + (β) `domainErrorFor` translator + (ii) friendly migration failure + (II) optional code on errorResponse**.

`lib/db/retry.ts` exports `withSqliteRetry(fn)` and `isBusyError(err)`. The retry runs synchronous busy-waits between attempts (50ms / 100ms / 200ms backoff, max 3 retries) — synchronous because all our SQLite calls are synchronous and we don't want to async-cascade. Total worst-case wait is ~350ms.

`lib/db/constraint-errors.ts` exports `DomainConstraintError`, `isConstraintError`, and `domainErrorFor`. The latter pattern-matches the SQLite message to extract the violated table.column and returns a typed error with stable `code: "unique_violation" | "foreign_key_violation"`. Other constraint flavours (CHECK, NOT NULL) pass through unchanged for now.

`lib/db/index.ts` wraps `runMigrations` + `runCryptoMigration` in try/catch. On failure, the partial DB handle closes (so we don't leak it), the underlying error logs, and a friendly message rethrows naming the DB path and the two recovery paths (back up + recreate, or restore from backup).

`lib/api/responses.ts#errorResponse(message, status?, code?)` — `code` is optional; existing call sites get the same `{error}` shape, new call sites can branch on `code` client-side. `validateBody` failures emit `code: "invalid_args"` so the chat error card (PR-D) can show "fix your input" specifically rather than a generic toast.

### Consequences

* Good — SQLITE_BUSY now self-heals on the dominant case (writer contention <50ms).
* Good — UNIQUE / FK violations turn into typed `DomainConstraintError` — API routes can map to 409 with `code: "unique_violation"` and the user sees "A row with this value already exists; pick a different identifier" instead of raw SQLite output.
* Good — migration failure now has a clear recovery message instead of an opaque 500 loop.
* Good — `errorResponse(msg, status, code)` gives every API route a way to emit a stable code without changing the existing `{error}` envelope shape.
* Bad — `withSqliteRetry` busy-waits synchronously rather than yielding via `setTimeout`. The retry budget is small (~350ms total), but this does block the Node event loop briefly. Acceptable: the alternative is making every store helper async, which cascades through hundreds of call sites.
* Bad — only UNIQUE + FK are translated today; CHECK/NOT NULL still leak. Acceptable: those are rare and usually indicate a real bug in our schema usage; raw text is appropriate for those.
* Bad — `errorResponse` signature change is backward compatible but the optional `code` parameter is easy to forget. Mitigated by `validateBody` automatically emitting `code: "invalid_args"` so most validation paths get codes for free.

## Pros and Cons of the Options

### (C) `withSqliteRetry` helper (chosen)

* Good — opt-in per store helper; covers the contention-prone writes without affecting reads.
* Good — synchronous, fits the existing store API.
* Neutral — busy-wait is mildly icky but bounded.

### (β) `domainErrorFor` translator (chosen)

* Good — one place to maintain the message-to-code mapping; tested in isolation.
* Good — store helpers stay simple: catch, call helper, rethrow.
* Neutral — only covers UNIQUE + FK today; extensible.

### (ii) Friendly migration failure (chosen)

* Good — turns a "cryptic 500 loop" into "actionable error message".
* Good — closes the partial DB handle so we don't leak.
* Neutral — the rethrown error still propagates (we can't continue without a working schema); just better-formatted.

### (II) Optional `code` on errorResponse (chosen)

* Good — additive; no existing caller breaks.
* Good — `validateBody` auto-emits `invalid_args` so most validation paths get codes for free.
* Good — completes the error-vocabulary picture: tools, providers, REST all speak the same codes.

## Implementation notes

* `lib/db/retry.ts`:
  - `BUSY_BACKOFFS_MS = [50, 100, 200]` — exponential, capped.
  - `withSqliteRetry<T>(fn: () => T): T` — synchronous; busy-waits between retries. Total worst-case ~350ms.
  - `isBusyError(err)` — checks both `code` (SQLITE_BUSY / SQLITE_LOCKED) and message text (node:sqlite emits without code field).

* `lib/db/constraint-errors.ts`:
  - `DomainConstraintError extends Error` with `code: "unique_violation" | "foreign_key_violation"` and optional `target` (table.column).
  - `isConstraintError(err)` — checks code prefix + message text.
  - `domainErrorFor(err)` — translates UNIQUE / FK; passes everything else through.

* `lib/db/index.ts`: `runMigrations` + `runCryptoMigration` now wrapped in try/catch. On failure: close partial DB, log the original, rethrow a friendly message naming the path and recovery options.

* `lib/api/responses.ts`:
  - `errorResponse(message, status?, code?)` — `code` optional; injects into the body when present.
  - `notFoundResponse(message?, code?)` — defaults to `code: "not_found"`.
  - `validateBody` returns `errorResponse(msg, 400, "invalid_args")` on Zod failure.

* Stores that catch constraint errors today (e.g. `createThread`) should be updated in a follow-up to call `domainErrorFor` and let the typed error propagate — this PR ships the helpers but doesn't sweep every call site to keep diff size manageable. The audit's recommendation was "audit every store before translating"; the translator + tests are the foundation for that sweep.

## Cross-references

ADR-0049 / 0050 / 0051 / 0052 (the rest of the error vocabulary). PR-1's `withToolTimeout` and PR-2's `summarizeTranscriptWithRetry` (same retry-helper pattern, different layer).
