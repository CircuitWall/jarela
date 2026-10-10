---
status: accepted
date: 2026-10-10
deciders: Jarela maintainers
---

# Preserve message sequence high-water marks

## Context and Problem Statement

Jarela exposes SQLite `rowid` as the message `seq`, and context boundaries,
pagination, compaction, and recovery use it as a durable ordering cursor.
SQLite can reuse a deleted maximum rowid when a table has no `AUTOINCREMENT`
alias. Full-context reset can delete the last foreground row while leaving only
lower-sequence automation rows, so a later insertion could fall below the
persisted reset cursor.

## Decision Drivers

* Keep message ordering strictly increasing across pruning and full reset.
* Preserve exact `seq` cursors without migrating every message to a new key.
* Keep allocation transactional with the message insert.
* Continue using the existing single SQLite database and process.

## Considered Options

* Keep implicit rowid allocation and rely on retained rows to hold the maximum.
* Rebuild `messages` around a new `AUTOINCREMENT` primary key.
* Persist a global high-water mark and assign each inserted rowid explicitly.

## Decision Outcome

Proposed: maintain a singleton `message_seq_allocator` row. Migrations seed its
high-water mark from the largest existing `messages.rowid`. `addMessage`
allocates `MAX(stored_high_water, current_max_rowid) + 1` and inserts that rowid
in the same SQLite transaction that advances the high-water mark and message
count. Deleting or pruning messages never lowers the allocator.

The explicit rowid remains the canonical `seq` everywhere else. Existing
messages need no rewrite, and direct legacy inserts are covered by comparing
the allocator with the current table maximum before each allocation.

### Consequences

* Good, because cursors remain ordered and are never reused after compaction or
  deletion.
* Good, because this avoids rebuilding the existing messages table and keeps
  references keyed by `msg_id` unchanged.
* Bad, because every transcript insert now writes the allocator row as part of
  its transaction; the allocator becomes required migration state.

## More Information

Builds on ADR-0088 (message sequence ordering) and ADR-0096 (exact context
boundary).