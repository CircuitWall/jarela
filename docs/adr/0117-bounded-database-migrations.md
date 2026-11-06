---
status: accepted
date: 2026-11-06
deciders: Jarela maintainers
---

# Bounded database migrations

## Context

The database initializer repeatedly runs historical schema checks and data
backfills. Older installations do not record the Jarela schema version, and
some encryption work is deferred until the master key is unlocked.

## Decision

Establish a 3.0 baseline for new installations and for unversioned databases
that pass baseline validation. Reject incompatible unversioned databases with
instructions to upgrade through 3.0; schema validation cannot establish which
application version last opened a database. Record successful migrations
durably and skip them on later starts. Preserve deferred encryption work until
it succeeds after unlock.

Support direct upgrades from the current and previous major release, with
3.0 as the initial minimum. At each major release, squash obsolete migrations
into a new baseline and remove upgrade paths older than the previous major.
Reject unknown newer migration versions rather than opening them with an older
application. The migration-ID policy test enforces the supported major window.
When squashing, stamp the new major baseline for upgraded databases and compact
retired markers only after their pending steps have completed. A locked database
must not lose the record that key-dependent work remains outstanding.

## Validation and consequences

Tests must cover fresh databases, a real 3.0 database fixture, repeated opens,
unsupported unversioned and newer databases, interrupted migrations, deferred
encryption and preservation of existing data. The version marker and schema
change must commit atomically. Filesystem side effects require separate
crash-safe handling; they cannot be made atomic by a SQLite transaction.

The one-time validation and baseline work can still block startup. This decision
does not establish the cause of an unrelated mid-turn connectivity failure.
