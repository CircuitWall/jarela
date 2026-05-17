---
status: accepted
date: 2026-05-15
deciders: Andrew Wu
---

# Use local SQLite (`~/.jarela`) for all persistent state

## Context and Problem Statement

Jarela is local-first. We need durable storage for LangGraph checkpoints, conversation memory, schedules, and user-supplied API keys, without depending on any hosted database.

## Decision Drivers

* Zero external dependencies for runtime.
* Single-user, single-host workload.
* Compatible with the chosen agent runtime (LangGraph SQLite checkpointer).
* Survive process restart and OS reboot.
* Easy backup (single directory).

## Considered Options

* SQLite under `~/.jarela` (chosen)
* Embedded LMDB / DuckDB
* Hosted Postgres / managed cloud DB
* JSON files on disk

## Decision Outcome

Chosen: **SQLite at `~/.jarela`**. Native LangGraph checkpoint support, SQL access for ad-hoc inspection, single-file backup, no daemon.

### Consequences

* Good â€” trivial setup, robust durability, queryable.
* Good â€” directory is configurable via `JARELA_DB_DIR`.
* Bad â€” single-writer; concurrent writers from multiple processes need WAL discipline.
* Bad â€” not suitable for multi-host state (would require a superseding ADR).

## More Information

* `.env.example` exposes `JARELA_DB_DIR`.
* Persistence code lives in `lib/db/` and `lib/stores/`.
