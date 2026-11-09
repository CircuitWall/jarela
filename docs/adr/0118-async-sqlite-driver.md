---
status: proposed
date: 2026-11-08
deciders: Andrew Wu
---

# ADR-0118: Target selected SQLite reads on worker connections

## Context

Jarela currently uses `node:sqlite` `DatabaseSync` for its local database.
Long transcript and model-history reads can delay other requests handled by
the same Node.js event loop. Replacing every store method with a Promise-based
API would spread async plumbing through much of the application and make
ordinary writes async as well.

## Decision

Keep the existing synchronous `DatabaseSync` connection as the canonical
writer and for ordinary small reads. Add a worker-backed SQLite read pool for
selected read-heavy store operations. Stores expose distinct method names and
contracts: synchronous methods retain their existing behavior, while a
measured read path gets an explicit `...Async` method. Store callers never
inspect SQL text or choose a driver.

Use WAL so read-only worker connections can read committed snapshots while the
writer is active. Calls inside a synchronous write transaction continue using
the writer connection; worker readers cannot see that transaction's
uncommitted changes. Writes remain synchronous by design and can still block
for their own execution or lock wait.

The initial candidate path is chat message pagination (`getMessagesPageAsync`,
`getMessagesAfterAsync`). `getRecentMessagesWindowAsync` — the bounded
message-history window used to prepare a model turn — is implemented and
unit-tested for row-level equivalence with its sync counterpart, but is not
yet wired into `buildHistoryWindow`: routing that read through the worker
pool raced the fire-and-forget hot-turn boundary compaction in
`lib/agents/run-thread.ts` and committed an unaligned boundary in one
integration test. Keep `buildHistoryWindow` on the synchronous read until
that interaction is root-caused. Keep existing synchronous store methods for
other callers. Add further async variants only when query timings show a
useful target.

Do not route methods by SQL keyword. A method's type and name must have one
stable contract; SQL syntax is not a safe way to decide whether the caller
receives a value or Promise.

## Consequences

- Existing synchronous writes, transactions, migrations, encryption, and
  checkpoint behavior remain on `node:sqlite`.
- Selected reads no longer execute on the request event loop and can use
  multiple read connections.
- Callers of selected async store methods must await their result, but the
  async handling is confined to the store boundary and its direct consumers.
- Worker lifecycle and native dependency packaging must be validated on
  Windows, macOS, and Linux.
- The read pool must close during graceful shutdown and in tests that use it.
- This does not remove delays caused by synchronous writes or by row
  serialization/copying after a worker read.

## Validation

- Verify async and sync store methods return identical rows for pagination,
  cursor, channel, status, and empty-result edge cases.
- Verify worker reads overlap synchronous writes under WAL without exposing
  uncommitted transaction state.
- Verify a deliberately slow worker query does not block an event-loop timer.
- Verify the pool closes cleanly and the app bundles the package worker/native
  files in its standalone Windows installer.
- Run typecheck, unit tests, build, E2E, and installer checks before treating
  the change as complete.

## References

- [ADR-0003: Use local SQLite](0003-sqlite-local-persistence.md)
- [ADR-0034: Replace better-sqlite3 checkpointer with node:sqlite](0034-replace-better-sqlite3-checkpointer-with-node-sqlite.md)
