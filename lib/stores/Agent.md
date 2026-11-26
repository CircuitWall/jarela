---
description: "Use when: implementing, fixing, or testing persistent state in lib/stores/"
tools: [read, edit, search, execute]
reasoning-effort: high
---

# Stores module guidance

Follow [AGENTS.md](../../AGENTS.md), [lib/db/Agent.md](../db/Agent.md), and the
[migration decisions](../../docs/adr/0117-bounded-database-migrations.md).
Stores own SQL, row mapping, value normalization, and encryption; routes and UI
never touch tables directly.

## Boundary

- The dependency direction is UI → API routes → runtime → stores → SQLite
  ([module map](../../docs/ARCHITECTURE.md)). Routes call typed store functions;
  they do not call `.prepare`.
- Persistent state belongs in `lib/db` or `lib/stores`. Do not write ad-hoc
  state files outside `JARELA_DB_DIR`; the documented filesystem exceptions are
  `lib/stores/skill-run-staging.ts` (ADR-0114) and the read-only pricing
  snapshot.
- Route/UI `getDb()` calls are bootstrap-only (health, idle timeout, redaction
  setup). New application reads and writes go through a store.
- Open an ADR before changing persistence schema or the data-directory layout.
  Migrations live under `lib/db`; a store that manages its own schema (the
  workflow-runs exception) must state why in code and architecture docs.

## Store authoring conventions

- **Rows mirror columns; domain shapes do not.** An exported `<Thing>Row`
  interface matches the SQL columns exactly: snake_case names, SQLite storage
  types, `0 | 1` booleans, JSON columns as `string | null`, credentials as
  encrypted strings. Convert to camelCase domain objects, parsed enums, and
  typed JSON in named `parse*`/`to*` helpers at the store boundary.
- **Timestamps are ISO-8601 strings** created with `new Date().toISOString()`
  (see `now()` in [agent-configs.ts](./agent-configs.ts)); do not store epoch
  numbers or `Date` objects in new columns.
- **Absence is not an error.** `get*` returns `null`, `list*` returns `[]`, and
  case-insensitive lookups normalize explicitly. Throw only for constraint
  violations, corruption, or failed invariants.
- **Writes return only what callers need.** Use `void` for fire-and-forget
  mutations, the updated row when the caller renders it, and an explicit
  `created` result when insert-and-return is the contract. Upserts are
  idempotent; conflicting inserts fail rather than overwrite silently.
- **One logical write, one transaction.** Open `withDbTransaction` around the
  full read-modify-write, read derived values back inside it, and perform no
  network or filesystem IO while it is open.
- **SQL lives here.** Routes and UI never import SQL or call `.prepare`. Prepare
  once at module scope (or use `cachedRead` on hot reads) and bind every value.
  Add an index for every filter/sort a public store function exposes.
- **Secrets stay encrypted.** Encrypt before binding, decrypt only in the
  function that must return plaintext, and never log row values. `tool-config`
  remains the reviewed plaintext exception.
- **Every growing collection has a lifecycle.** Name the cap, TTL, or retention
  rule in the store, and call the invalidation hook on writes that change
  derived data.
- **A new store ships complete:** row interface, verb-named exports, tests,
  a [file-map](#file-map) row, an ADR when it adds or changes schema, and a
  documented retention rule.

## Standard patterns

### 1. Export typed row functions

Each store exports `interface <Thing>Row` plus named functions with predictable
verbs: `get*` for one row or null, `list*` for arrays, `put*`/`set*`/`upsert*`
for writes, `delete*`/`remove*` for removal, `create*` for insert-and-return,
and `mark*`/`record*` for state transitions. Helpers are `parse*`/`is*`.

Canonical: [threads.ts](./threads.ts), [agent-configs.ts](./agent-configs.ts),
[credentials.ts](./credentials.ts), [document-sources.ts](./document-sources.ts).
All exports are named; there are no default exports in this directory.

### 2. Read-modify-write inside `withDbTransaction`

Multi-statement writes use [the transaction helper](../db/transaction.ts)
(savepoints), usually through a private `...Transaction` helper. Do not
hand-roll `BEGIN`/`COMMIT`/`ROLLBACK`.

Canonical: [agent-configs.ts](./agent-configs.ts),
[credentials.ts](./credentials.ts), [app-settings.ts](./app-settings.ts),
[threads.ts](./threads.ts). The known holdout is
[tool-stats.ts](./tool-stats.ts); do not extend it.

### 3. Encrypt secret values before binding

Secrets are encrypted before persistence and decrypted through the shared
helpers; sensitive namespaces are centralized in
[lib/crypto/sensitive.ts](../crypto/sensitive.ts). Representative stores:
[credentials.ts](./credentials.ts), [memory.ts](./memory.ts),
[mcp-servers.ts](./mcp-servers.ts), [allowed-sites.ts](./allowed-sites.ts),
[pending-actions.ts](./pending-actions.ts), [workflow-runs.ts](./workflow-runs.ts).

`tool-config.ts` is intentionally plaintext and non-sensitive; do not copy that
exception for values that carry secrets.

### 4. Decode tolerant JSON only where a fallback is sanctioned

Use [app-settings-json.ts](./app-settings-json.ts) /
[lib/utils/json.ts](../utils/json.ts) for nullable legacy settings whose owners
permit a fallback. Security and policy readers stay strict and propagate
corruption or schema failures. See the tolerant-vs-strict split in
[ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

### 5. Parameterize every value

Only structural SQL (fixed column lists, generated `?` placeholders, `NOT IN`
lists) may be interpolated. Caller values are always bound. The single
identifier path is schema-derived and quote-escaped in
[agent-configs.ts](./agent-configs.ts); treat it as a reviewed exception.

### 6. Bound growth and preserve invalidation

Every unbounded collection needs a cap, TTL, or retention rule. Existing
examples: [memory.ts](./memory.ts) history cap,
[background-results.ts](./background-results.ts) size/age,
[workflow-runs.ts](./workflow-runs.ts) retention,
[system-signals.ts](./system-signals.ts) payload/backlog bounds,
[workspace-scan-cache.ts](./workspace-scan-cache.ts) TTL.

Writes that invalidate derived data must call the existing invalidation hook:
[change-tracker.ts](./change-tracker.ts),
[agent-advertisements.ts](./agent-advertisements.ts), and
[agent-configs.ts](./agent-configs.ts) show the shape.

### 7. Reuse statements on hot paths

Use `cachedRead` from [statement-cache.ts](../db/statement-cache.ts) and hoist
prepares out of loops; [threads.ts](./threads.ts) is the reference use.

## Anti-patterns

- **String-interpolated values** — SQL injection and query-plan churn.
- **Manual transactions** — bypass savepoint nesting and error handling.
- **Per-call schema probing** — `init*Schema()` on every operation adds
  `PRAGMA table_info` cost; initialize once or rely on migrations.
- **Cross-store table access** — reading another store's tables directly
  couples schemas. Cascades and aggregates exist; new ones need an explicit
  reason or a store-owned query. See the approved exceptions below.
- **Unbounded JSON columns** — add caps before storing transcripts, artifacts,
  or backlogs.
- **Plaintext secrets** — route sensitive values through `lib/crypto`.
- **New ad-hoc files** — persistence belongs in SQLite under `JARELA_DB_DIR`.
- **Skipping the ADR** — schema and directory changes require one.

## Cross-store access exceptions

Stores own their tables. Direct access to another store's tables is allowed
only for referential integrity or a read-only aggregate, and every case must
be listed here:

| Store | Cross-store access | Why |
| --- | --- | --- |
| `credentials.ts` | reads `model_configs`, `agent_configs` | refuse deleting a referenced credential |
| `model-config.ts` | clears `agent_configs.model_config_name` | referential integrity on delete |
| `harnesses.ts` | clears `agent_configs.harness_id` | referential integrity on delete |
| `threads.ts` | deletes matching `memory_store` archive rows | cascade thread → chat archive |
| `system-signals.ts` | reads/updates `background_tool_results`, `pending_actions` | delivery leases and failure settlement |
| `dashboard-metrics.ts` | joins `agent_configs`, `model_configs` | read-only dashboard aggregate |
| `agent-dreams.ts` | reads/deletes rows keyed by `agent_configs.id` | prune dream state after agent deletion; `agent_configs` uses `INSERT OR REPLACE`, so a cascading FK would erase state on every agent edit |

Anything else must go through the owning store's exported functions. Adding a
new exception requires updating this table, a test that covers the cascade,
and review of the owning store's schema.

## Review checks

- [ ] The store owns its tables; cross-store access is listed in the exception table.
- [ ] Row interfaces mirror SQL columns; domain conversion lives in named helpers.
- [ ] Multi-statement writes use `withDbTransaction`; no network or filesystem IO inside.
- [ ] Every value is bound; new filters and sorts are indexed.
- [ ] Secrets are encrypted before binding and never logged.
- [ ] Growth is bounded and invalidation hooks fire on derived-data writes.
- [ ] Tests cover round-trip, rollback, encryption, retention, and tolerant/strict decode.
- [ ] Focused store tests, `npx tsc --noEmit`, and `npm run lint` pass.

## Testing requirements

- Co-located `lib/stores/*.test.ts`. The global
  [test setup](../../tests/setup-data-dir.ts) gives every file a temporary
  `JARELA_DB_DIR`; override it before dynamic imports when the test needs its
  own directory ([credentials.test.ts](./credentials.test.ts),
  [threads.test.ts](./threads.test.ts)).
- Apply migrations through `getDb()`; assert idempotent re-runs when touching
  schema. In-memory SQLite fixtures are acceptable for store-owned schemas
  ([workflow-runs.test.ts](./workflow-runs.test.ts)).
- Cover: row round-trip, null/missing rows, tolerant vs strict decode, encryption
  at rest, transaction rollback, cache invalidation, and retention bounds.
- Clean up temp directories in `afterAll`; Windows may hold SQLite handles, so
  cleanup is best effort.
- Run the focused store tests, `npx tsc --noEmit`, and `npm run lint`.

## File map

| Concern | Stores |
| --- | --- |
| Agents/configs | `agent-configs.ts`, `model-config.ts`, `agent-advertisements.ts`, `agent-dreams.ts`, `builtin-tools.ts`, `task-assignments.ts`, `user-profile.ts`, `access.ts` |
| Credentials/secrets | `credentials.ts`, `integrations.ts`, `integration_meta.ts`, `tool-secrets.ts`, `tool-config.ts`, `mcp-servers.ts`, `proxy-config.ts`, `allowed-sites.ts` |
| Settings | `app-settings.ts`, `app-settings-json.ts`, `harnesses.ts`, `model-metadata.ts`, `pricing.ts`, `change-tracker.ts` |
| Documents/memory | `memory.ts`, `document-sources.ts`, `message-embedding-jobs.ts`, `langgraph-store.ts` |
| Scheduling/triggers | `scheduled-tasks.ts`, `watchers.ts`, `system-signals.ts`, `pending-actions.ts`, `background-results.ts`, `workflow-runs.ts` |
| Conversation | `threads.ts`, `message-usage.ts`, `automation-activity.ts` |
| Integrations/bridges | `bridges.ts`, `skill-repos.ts`, delegate-session stores |
| UI/dashboard | `dashboard-metrics.ts`, `tool-stats.ts`, `browser-command-log.ts`, `workspace-scan-cache.ts` |

## Frontier

- **Store-owned versioned schema with CAS** ([workflow-runs.ts](./workflow-runs.ts)):
  injected `DatabaseSync`, idempotent migration, encrypted CAS payload. Outside
  `lib/db` migrations by design; ADR-0114.
- **Filesystem staging store** ([skill-run-staging.ts](./skill-run-staging.ts)):
  ownership files, device/inode identity, atomic rename. ADR-0114.
- **Bounded keyset scanning** ([memory.ts](./memory.ts)): configurable batch and
  cursor. One implementation; candidate for other large-table scans.
- **Explicit `...Async` read-pool methods** ([threads.ts](./threads.ts),
  [document-sources.ts](./document-sources.ts)): keeps sync APIs separate from
  worker-pool reads; not yet universal.
