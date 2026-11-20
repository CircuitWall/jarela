# ADR-0124: One SQLite pragma profile for every long-lived connection

Status: **Accepted**

Date: 2026-11-20

Related: [ADR-0003](./0003-sqlite-local-persistence.md) (local SQLite),
[ADR-0118](./0118-async-sqlite-driver.md) (worker-backed reads),
[ADR-0005](./0005-encrypted-secrets-at-rest.md) (master key / locked state).

## Context

The database layer left every connection on SQLite's defaults, and the
documentation claimed otherwise: `lib/db/Agent.md` said `synchronous = OFF`
while `lib/db/index.ts` only set `journal_mode` and `foreign_keys`, so a live
install ran `synchronous = FULL`. Observed consequences on an install with a
3 GB `jarela.db`:

- `[event-loop] blocked for 2219ms` warnings whose context was a single-row
  `UPDATE access_whitelist SET last_seen_at = ?` taking 540 ms.
- Same statement, same data, measured offline: p50 2.1 ms and max 7.8 ms over
  3000 iterations, so the 540 ms was the flush, not the statement. The commit
  that trips the autocheckpoint also fsyncs the database file: one such
  checkpoint took 411 ms while the file had pending dirty pages and 1.9 ms once
  clean.
- `synchronous = NORMAL` on the same workload: p50 0.02 ms (100× less), and
  under 16 CPU-burning processes on 12 cores the max was 0.5 ms instead of
  82 ms.
- `busy_timeout = 0`, so a competing writer (a CLI, a script, a second
  instance) fails immediately with `SQLITE_BUSY` instead of waiting.
- `cache_size = -2000` (2 MiB) against a 3 GB file.
- WAL files kept their high-water mark: a 20 MB `jarela.db-wal` was observed on
  an idle install, and one 120 MB transaction left the file that size.

## Decision

Configure every long-lived connection through
`applyConnectionPragmas()` in `lib/db/pragmas.ts`:

| Pragma | Value | Why |
| --- | --- | --- |
| `journal_mode` | `WAL` | Concurrent readers while writing; required by the read pool |
| `synchronous` | `NORMAL` | Crash-safe in WAL; removes the per-commit fsync |
| `busy_timeout` | `5000` | A second writer waits instead of failing instantly |
| `cache_size` | `-65536` (64 MiB) | 2 MiB thrashes on a multi-GB database |
| `journal_size_limit` | `33554432` (32 MiB) | Bounds the WAL high-water mark |
| `foreign_keys` | `ON` | Referential integrity |

Applied to the app database (`lib/db/index.ts`) and the LangGraph checkpoint
store (`lib/agents/sqlite-checkpoint-saver.ts`). Store code must not set
connection pragmas of its own; a connection with different durability or cache
settings reintroduces the stalls this profile removes.

The read pool's worker connections keep their driver defaults: the pool API
(`@appthreat/sqlite3`) exposes only `readers`, `walMode`, `busyTimeout` and
`integerMode`. They are read-only, so `synchronous` does not apply to them, and
raising their page cache needs an upstream option.

## Consequences

- A process crash loses nothing. A power loss or OS crash can roll back the most
  recent commits — acceptable for chat history and settings, and consistent with
  what the documentation already claimed.
- Each long-lived connection reserves up to 64 MiB of page cache (two in the
  server process: app database and checkpoints).
- A concurrent writer waits up to 5 s instead of failing at once, which can
  block the event loop for that long in the rare case another process holds the
  write lock.
- WAL files stop growing without bound, so antivirus and backup scans see a
  smaller file.
- Writes remain synchronous (`node:sqlite` `DatabaseSync`); this profile
  reduces what each write waits for, it does not move writes off the loop.

## Validation

- `lib/db/pragmas.test.ts` asserts the profile on the app database and on a
  standalone connection.
- Measured before/after on the authoring machine (3 GB database): the numbers in
  the Context section.
- Typecheck, lint, unit tests, E2E, and the packaged-app smoke test run on every
  PR through CI.
