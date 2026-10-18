---
status: accepted
date: 2026-10-18
deciders: Jarela maintainers
---

# Index transcript reads by their actual ordering keys

## Context

Message pagination filters by thread and orders by the canonical SQLite rowid
cursor, while the existing `(thread_id, created_at)` index requires a temporary
sort. Dashboard date windows and agent thread lists also lack matching indexes.
Synchronous scans and sorts can delay other requests in the single Node process.

## Decision

Add idempotent indexes on `messages(thread_id)`, `messages(created_at)`,
and `threads(updated_at DESC)`.
Ordinary SQLite secondary indexes include rowid as their final ordering key, so
the thread-only message index supports both directions of cursor pagination.
Keep the existing thread/timestamp index for time-window conversation reads.
No tables, message cursors, or stored values change.

Also index latest usage by `(thread_id, created_at DESC)`, memory lists by
`(namespace, updated_at DESC)` and `(updated_at DESC)`, and runtime operation
backlogs by `(thread_id, state)`. Add signal-event indexes on `thread_id` and
`operation_id` for backlog counts, pruning, and foreign-key cascades. Index
background-result expiry for retention cleanup.

The embedding-job and signal-delivery indexes on `(state, available_at...)`
cannot bound the separate `lease_until` range. Add `(state, lease_until_ms)` for
embedding jobs and `(state, lease_until)` for signal deliveries. Compute the
next embedding wakeup from two indexed minima rather than scanning all active
jobs through a CASE expression. Preserve due-work ordering and lease semantics.

Do not add another agent/thread index: the existing unique
`threads(agent_id)` index already limits an agent lookup to one row.
Checkpoint reads already use the composite primary keys on checkpoint and
write identifiers; no extra checkpoint index is justified by those hot reads.

## Validation

Migration tests must verify index creation on upgrade, repeatability, and query
plans without table scans or temporary ordering trees for the targeted reads.
Existing pagination tests remain the source of truth for message ordering.

## Consequences

Reads avoid unnecessary scans and sorting at the cost of extra index storage,
write maintenance, and a one-time index build when an existing database opens.
No user action or database-file relocation is required.
