---
description: "Use when: designing, querying, or migrating SQLite schemas in lib/db/"
tools: [read, edit, search, execute]
reasoning-effort: high
---

# SQLite & Database Persistence Agent

Scope: `lib/db/` — connection setup, pragmas, schema migrations, transactions,
statement caching, read scheduling, and checkpoint storage.

Follow [AGENTS.md](../../AGENTS.md), the [stores guide](../stores/Agent.md), and
[the migration ADR](../../docs/adr/0117-bounded-database-migrations.md). Stores
own row mapping and SQL for their tables; this module owns the database
contract. Application code never calls SQLite directly.

## Architecture

```text
Application (lib/stores, lib/agents)
  ↓ typed store methods
Synchronous writer (node:sqlite DatabaseSync)
  + optional read-only worker pool (@appthreat/sqlite3)
  ↓
SQLite WAL files under $JARELA_DB_DIR
```

## Invariants

### Pragma profile

[pragmas.ts](./pragmas.ts) is the single source: `journal_mode = WAL`,
`synchronous = NORMAL`, `busy_timeout = 5000`, `cache_size = -65536` (64 MiB),
`journal_size_limit = 33554432` (32 MiB), and `foreign_keys = ON`. Apply it
through `applyConnectionPragmas()`; never set pragmas per query or per store.
Changing the profile requires an ADR and an update to
[pragmas.test.ts](./pragmas.test.ts). `auto_vacuum` is a file-layout pragma
chosen at creation (incremental) and is never changed at boot. `getDb()` runs
`PRAGMA optimize` on open — keep that cheap and synchronous.

### Migration authoring

Append to `SCHEMA_MIGRATIONS` in [migrations.ts](./migrations.ts) with a unique,
versioned id; never edit or reorder an applied migration. Each step guards on
schema state before altering (`pragma_table_info`, `sqlite_schema`), records
completion in `jarela_migrations` atomically, and is safe to re-run. Support
direct upgrades from the current and previous major release (3.0 minimum), and
test both a baseline upgrade and a second idempotent run. Destructive rebuilds,
data rewrites, and new data directories need an ADR. Key-dependent work stays in
the deferred migration path until unlock.

### Read path

Keep writes and small reads on the synchronous writer. When a read can grow with
user data (message history, chunks, transcripts), add a separately named
`...Async` store method that uses `readAppRows` from
[read-pool.ts](./read-pool.ts); never expose a value-or-Promise union. The pool
uses four read-only WAL readers — close it with `closeReadPool()` during
shutdown and isolated tests. Async readers see committed WAL snapshots only;
read-after-write work stays on the writer.

### Statements and encryption

Use prepared statements with bound parameters everywhere. `cachedRead` from
[statement-cache.ts](./statement-cache.ts) is for hot, stable SQL; hoist
prepares out of loops and call `clearStatementCache()` when a migration
invalidates statements. Secrets are encrypted through
[lib/crypto/envelope.ts](../crypto/envelope.ts) before binding; sensitive
namespaces are centralized in [lib/crypto/sensitive.ts](../crypto/sensitive.ts).
Never log row values, and never store plaintext secrets.

## Standard patterns

### 1. Schema change

Open an ADR, then add a versioned migration with its completion marker and any
indexes in the same transaction. Test a fresh database, each supported source
version, repeat opens, rollback, and an unknown newer version. Do not edit the
frozen 3.0 baseline for a new migration.

### 2. Parameterized query

Every caller value is bound. Only structural SQL (fixed column lists, generated
placeholders) may be interpolated. Canonical typed examples live in
[lib/stores/threads.ts](../stores/threads.ts); routes and UI never call
`.prepare`.

### 3. Transaction

Wrap the full read-modify-write in `withDbTransaction()` from
[transaction.ts](./transaction.ts). It uses savepoints, so nesting is safe.
Never hand-roll `BEGIN`/`COMMIT`/`ROLLBACK`, never perform network or filesystem
IO inside a transaction, and read derived values back before releasing it.

### 4. Secret storage

Encrypt before persistence with `encrypt`; decrypt only where plaintext is
required with `decryptIfNeeded`. Own the value in the owning store; the
`tool-config` plaintext exception is reviewed, not a pattern. See
[lib/stores/credentials.ts](../stores/credentials.ts) for the shape.

### 5. Checkpoint persistence

LangGraph state is stored by `NodeSqliteSaver` in
[sqlite-checkpoint-saver.ts](../agents/sqlite-checkpoint-saver.ts) and obtained
through `getCheckpointer()` in [checkpointer.ts](../agents/checkpointer.ts).
Checkpoint writes belong in the same turn lifecycle as message persistence.

## Anti-patterns

- **String-interpolated values** — injection risk and query-plan churn.
- **Manual transactions** — bypass savepoint nesting and rollback handling.
- **Plaintext secrets** — leak through backups and dumps.
- **Missing indexes or N+1 queries** — a query per row on a growing table.
- **Huge transactions** — lock the writer for minutes; batch large writes.
- **Foreign keys off or ad-hoc pragmas** — orphaned rows and measured stalls.
- **Per-call schema probing** — `init*Schema()` on every operation is wasted IO;
  migrate once or rely on the migration version.
- **Ad-hoc persistence files** — state belongs in SQLite under `JARELA_DB_DIR`.

## File map

| Concern | Files |
| --- | --- |
| Connection and schema | [index.ts](./index.ts), [data-dir.ts](./data-dir.ts), [migrations.ts](./migrations.ts), [baseline-v3.ts](./baseline-v3.ts), [pragmas.ts](./pragmas.ts) |
| Transactions and reads | [transaction.ts](./transaction.ts), [read-pool.ts](./read-pool.ts), [statement-cache.ts](./statement-cache.ts), [timing.ts](./timing.ts) |
| Tests | [migrations.test.ts](./migrations.test.ts), [versioned-migrations.test.ts](./versioned-migrations.test.ts), [deferred-migrations.test.ts](./deferred-migrations.test.ts), [transaction.test.ts](./transaction.test.ts), [pragmas.test.ts](./pragmas.test.ts), [read-pool.test.ts](./read-pool.test.ts), [statement-cache.test.ts](./statement-cache.test.ts), [test-isolation.test.ts](./test-isolation.test.ts) |

## Testing requirements

- Run migrations against a fresh in-memory database and assert the required
  tables and indexes exist ([migrations.test.ts](./migrations.test.ts)).
- Re-run migrations and assert idempotence; cover an upgrade from each supported
  version and an unknown newer marker
  ([versioned-migrations.test.ts](./versioned-migrations.test.ts)).
- Cover deferred key-dependent migrations after unlock
  ([deferred-migrations.test.ts](./deferred-migrations.test.ts)).
- Assert rollback and commit behavior for nested savepoints
  ([transaction.test.ts](./transaction.test.ts)).
- Assert the pragma profile on every connection
  ([pragmas.test.ts](./pragmas.test.ts)); close the read pool in teardown
  ([read-pool.test.ts](./read-pool.test.ts)).
- Cover statement-cache invalidation and per-file test isolation
  ([statement-cache.test.ts](./statement-cache.test.ts),
  [test-isolation.test.ts](./test-isolation.test.ts)).
- Run the focused Vitest files, `npx tsc --noEmit`, and `npm run lint`.

## Operational notes

- Back up by copying `jarela.db` with its `-wal` and `-shm` files; all three are
  required for a consistent snapshot.
- Diagnose corruption with `PRAGMA integrity_check`; restore from backup if
  recovery fails.
- The SQLite CLI is for read-only debugging. Normal reads and writes go through
  typed stores so encryption, validation, and locking stay intact.

## Review checks

- [ ] Schema change has an ADR and a versioned, idempotent migration.
- [ ] Migration tests cover fresh install, supported upgrade, and re-run.
- [ ] Every value is bound; no interpolated SQL.
- [ ] Multi-statement writes use `withDbTransaction()`.
- [ ] Secrets are encrypted before binding and absent from logs.
- [ ] New filters/sorts have an index; no N+1 query.
- [ ] Growing reads have a named async store method and the pool is closed in
      teardown.
- [ ] Pragma profile, foreign keys, and file layout are unchanged.
- [ ] Focused tests, `npx tsc --noEmit`, and `npm run lint` pass.
