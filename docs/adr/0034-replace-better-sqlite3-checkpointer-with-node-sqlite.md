---
status: "accepted"
date: 2026-05-28
deciders: andwu
---

# ADR-0034: Replace better-sqlite3 checkpointer with node:sqlite

## Context and Problem Statement

LangGraph thread state is persisted via the
`@langchain/langgraph-checkpoint-sqlite` package, which depends
transitively on `better-sqlite3 ^12.6.0`. That dependency in turn carries
`prebuild-install ^7.1.1` for native-binding installation.

`prebuild-install` was archived and deprecated by upstream on 2026-02-19,
with the maintainers recommending a different toolchain (`prebuildify` +
`node-gyp-build`). There is no non-EOL release of `prebuild-install`;
`7.1.3` is the final version.

Because `better-sqlite3` itself has not migrated off `prebuild-install`
([WiseLibs/better-sqlite3 install script]), supply-chain scanners
(Sonatype IQ in our case) flag every Jarela build as containing an
end-of-life component. Downstream forks that gate merges on those
scanners are blocked indefinitely.

Meanwhile, Jarela already uses `node:sqlite`'s `DatabaseSync` for its own
DB (see [lib/db/migrations.ts](../../lib/db/migrations.ts)) — Node 22.5+
made `node:sqlite` stable, and Jarela's `package.json` already pins
`@types/node` to a Node-25-era release. We have a viable in-tree
replacement driver that ships with Node itself.

## Decision Drivers

* Eliminate the EOL `prebuild-install` root from our dependency tree.
* Avoid adding a second native-module driver — Jarela should converge on
  one SQLite implementation, and `node:sqlite` is already in use.
* Preserve existing checkpoint files (`~/.jarela/checkpoints.db`) without
  a migration step — a database swap that requires user action would be a
  poor trade for a supply-chain hygiene change.
* Don't fork or vendor the upstream LangGraph checkpoint package — the
  surface (`BaseCheckpointSaver`) is small enough to implement directly.

## Considered Options

1. **Request a Sonatype waiver** for `prebuild-install:7.1.3` on every
   downstream application that scans the Jarela tree.
   *Rejected*: shifts the burden to every fork operator and re-surfaces
   on every minor better-sqlite3 bump. Doesn't actually fix the
   supply-chain risk.

2. **Fork `better-sqlite3` onto `prebuildify` + `node-gyp-build`.**
   *Rejected*: large maintenance surface, blocks future upstream bumps,
   doesn't reduce the number of native drivers in the tree.

3. **Migrate the checkpointer to libSQL** (e.g. `@libsql/client`).
   *Rejected*: adds a new runtime dep, async-only API breaks LangGraph's
   sync transactional pattern, and libSQL's network-first design adds
   latency that's pure overhead for a local file.

4. **Re-implement `BaseCheckpointSaver` against `node:sqlite`.** The
   upstream `SqliteSaver` is ~270 lines of straightforward SQL plus
   serializer plumbing — direct port is feasible. ✓ chosen.

## Decision

Add `lib/agents/sqlite-checkpoint-saver.ts` exporting `NodeSqliteSaver`,
a drop-in replacement for `SqliteSaver` that uses `DatabaseSync` from
`node:sqlite`. Switch `lib/agents/checkpointer.ts` to instantiate the
new class. Drop `@langchain/langgraph-checkpoint-sqlite` from
`dependencies` and add `@langchain/langgraph-checkpoint` directly (it
was previously transitive).

Schema is byte-identical to the upstream `SqliteSaver` DDL — existing
`checkpoints` and `writes` tables continue to read and write without
migration. SQL is preserved verbatim including the `json_group_array` /
`json_object` projections used to inline pending writes.

API differences bridged:

| `better-sqlite3` | `node:sqlite` |
|---|---|
| `db.pragma("journal_mode=WAL")` | `db.exec("PRAGMA journal_mode=WAL")` |
| `db.transaction(fn)()` (sugar) | manual `BEGIN`/`COMMIT`/`ROLLBACK` |
| `undefined` → NULL on bind | explicit `null` coercion |

## Consequences

### Positive

* `prebuild-install` and `better-sqlite3` are gone from the dependency
  tree. The standalone bundle drops two native modules.
* One SQLite driver (`node:sqlite`) for the whole project — the
  rationale for keeping the checkpointer DB in a separate file becomes
  purely about schema isolation, not driver contention.
* Downstream sonatype-style supply-chain checks unblock without
  per-fork waivers.
* No user-visible change: the checkpointer's public surface is the
  abstract `BaseCheckpointSaver`, and the on-disk schema is identical.

### Negative

* We carry a small fork of upstream's `SqliteSaver`. If LangGraph's
  checkpoint protocol evolves (new methods on `BaseCheckpointSaver`,
  changes to the pending-writes encoding, schema migrations), we must
  follow.
  *Mitigation*: pin `@langchain/langgraph-checkpoint` directly so
  protocol-level changes show up as deliberate version bumps; the unit
  test suite in `sqlite-checkpoint-saver.test.ts` exercises every method
  and pins the DDL via a regression assertion so silent drift surfaces
  as a test failure.
* `node:sqlite` does not provide better-sqlite3's `db.transaction(fn)`
  sugar; transactional methods (`putWrites`, `deleteThread`) implement
  `BEGIN`/`COMMIT`/`ROLLBACK` by hand. Slightly more code to read.

## Cross-references

* [WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
  — still depends on the deprecated `prebuild-install`.
* [prebuild/prebuild-install#216](https://github.com/prebuild/prebuild-install/issues/216)
  — upstream deprecation notice and migration guidance.
* [tink-ab/vclaw#1](https://github.com/tink-ab/vclaw/pull/1) — the
  downstream PR whose `sonatype-cli` check this change unblocks.
