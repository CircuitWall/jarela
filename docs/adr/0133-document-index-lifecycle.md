# ADR-0133: Document index lifecycle — purge, retention, and live space reclamation

Status: **Accepted**

Date: 2026-11-26

Related: [ADR-0024](./0024-document-rag.md) (document RAG and its tables),
[ADR-0124](./0124-sqlite-connection-pragmas.md) (connection pragma profile),
[ADR-0117](./0117-bounded-database-migrations.md) (versioned migrations).

## Context

ADR-0024's document RAG index only grew. Disabling a source stopped future
ingestion but kept every document and chunk; deleting files and sources was the
only way to reclaim storage, and nothing reported how much a source contributed.
Measurements on one live install (Jarela 3.8.0, Windows) reproduced the problem:

- `jarela.db` was 3.0 GiB and `document_chunks` was 2.78 GB of it
  (244,590 chunks over 53,995 documents).
- Three disabled mail sources still held 4,592 chunks. Search already excluded
  them (`document_sources.enabled = 1`), so they were pure storage.
- `auto_vacuum = 0` with 589 free pages. Deleting chunks did not shrink the
  file, so users saw no benefit from cleanup and re-ran expensive indexing.
- Per-source counters had been reduced to `document_count` because counting
  `document_chunks` read every embedding (3–17 s measured). The panel could not
  show that one source owned 72 % of the index.

The recall and storage-encoding findings from the same audit (JSON-encoded
embedding vectors, the 20k-chunk scoring cap, vendored-tree ingestion) are
separate decisions and are not changed here.

## Decision

1. **Record when a source was disabled.** `document_sources.disabled_at` is set
   on the enabled→disabled transition, preserved across label edits, and cleared
   on re-enable. The migration backfills existing disabled rows from
   `updated_at`. This is a schema change; it is additive and rollback-safe.
2. **Purge is an explicit, source-scoped action.** Deleting a source's index
   removes its `documents` rows and chunks but keeps the source row and config.
   Removing `documents` rows makes the next sweep treat every file as new, so a
   re-enable or rescan re-indexes it. The panel offers this for any source and
   automatically for disabled sources that still hold chunks.
3. **Retention is opt-in and defaults to off.** `purge_disabled_after_days`
   (0–3650, default 0 = keep) purges a disabled source's index only after its
   grace period. The scheduler evaluates it and runs the purge in the background.
4. **Chunk counts come from maintained data, not the chunk table.**
   `documents.chunk_count` already records each document's chunk count. Summing
   it per source is index-only; the panel and API restore `chunk_count` without
   scanning `document_chunks`.
5. **New databases use incremental auto-vacuum.** The pragma is set on an empty
   database before WAL or table creation, so freed pages can be returned to the
   filesystem incrementally. Existing databases keep `auto_vacuum = 0` until an
   explicit compaction.
6. **Maintenance runs on a dedicated writer worker.** Purges, incremental
   reclaim, and the one-time compaction use an `@appthreat/sqlite3` pool with a
   single writer connection (`readers: 0`), so multi-second deletes and VACUUM
   never run on the synchronous app connection. Incremental reclaim processes
   bounded page batches and yields between them so app writes can interleave.
7. **Compaction is explicit and warned.** Switching an existing database to
   incremental auto-vacuum requires `PRAGMA auto_vacuum = INCREMENTAL; VACUUM`.
   It rewrites the file, needs disk space for a compacted copy, and holds
   SQLite's write lock; the UI must confirm before starting it.

The maintenance pool cannot use `applyConnectionPragmas()` (ADR-0124): the pool
API exposes only readers, WAL, busy timeout, and integer mode. It keeps `WAL`,
`busy_timeout = 5000`, and sets `foreign_keys = ON` explicitly like the app
connection. Purges also delete chunks before documents, so they do not depend on
cascade being enabled on that connection.

## Consequences

- Disabled sources remain searchable-by-config but not by recall, and their
  storage is now visible and reclaimable. Re-enabling before the grace period
  costs nothing; after a purge it costs one re-index.
- Purging does not shrink the file on an `auto_vacuum = 0` database; the panel
  says so and offers the one-time compaction. After compaction, purges can
  reclaim pages live.
- Full VACUUM still pauses other SQLite writers (readers continue under WAL) for
  its duration. It is never scheduled automatically.
- `chunk_count` is only as accurate as `documents.chunk_count`; indexer and
  cascade paths maintain it, and the live measurements matched exactly.
- The maintenance writer is a second long-lived connection (one worker), in
  addition to the app connection, the checkpoint connection, and the read pool.

## Alternatives considered

- **Purge automatically on disable.** Rejected: re-indexing mail or a large
  folder can be expensive, and the issue itself asks for opt-in. Retention with
  a grace period gives the same storage benefit without the surprise.
- **Count chunks by scanning `document_chunks`.** Rejected: that was the 3–17 s
  query the panel previously removed. `SUM(documents.chunk_count)` answers the
  same question from maintained data.
- **Run VACUUM on the app connection.** Rejected: `node:sqlite` is synchronous,
  so a multi-GB rewrite would freeze every handler, stream, and timer.
- **Enable incremental auto-vacuum implicitly by running VACUUM at boot.**
  Rejected: startup would block for minutes on a large install and could fail
  for lack of temporary disk space. New installs get the mode for free; existing
  installs get an explicit, confirmed action.
- **Delete whole sources instead of purging their index.** Rejected: it loses
  the user's configuration, credentials linkage, and source identity. Purging
  keeps configuration while removing derived data.

## Validation

- `lib/documents/lifecycle.test.ts` covers purge isolation, retention cutoffs,
  the disabled-at transition, incremental reclaim, compaction, the serialized
  runner, and the scheduler sweep.
- `app/api/v1/documents/lifecycle/route.test.ts` covers validation, missing
  sources, the reclaim precondition, confirmation, 202 acceptance, and conflicts.
- `lib/db/versioned-migrations.test.ts` and
  `lib/db/deferred-migrations.test.ts` cover the migration and the frozen 3.0
  fixture. New databases are asserted to report incremental auto-vacuum.
- The live measurements in Context were reproduced read-only against the
  reported database before implementing (counts, free pages, disabled chunks).
