---
status: proposed
date: 2026-10-10
deciders: Jarela maintainers
---

# Centralize transcript lifecycle and embeddings

## Context and Problem Statement

Transcript rows are written by chat, automation, bridges, and capture flows.
`addMessage` currently starts best-effort embedding work in memory, while a
separate embedding scan repairs rows later. A process restart can lose pending
work, edits can race an old embedding result, and maintenance triggers are not
owned by one message lifecycle boundary.

## Decision Drivers

* Preserve every user-visible transcript item and its insertion order.
* Make embedding work durable, retryable, and safe across message edits and
  deletion.
* Keep one application entry point for transcript writes and lifecycle hooks.
* Keep transcript retention independent from the existing LLM context caps.
* Keep the existing single-process architecture and local SQLite persistence.

## Considered Options

* Keep embedding best-effort in `addMessage` and periodically scan for misses.
* Add a database-backed message lifecycle service and durable work queue.
* Move embedding and maintenance into a separate worker process.

## Decision Outcome

Proposed: use one message lifecycle service backed by the existing SQLite
database. Domain-specific writers may call the service, but direct transcript
row writes must converge on it. The service owns message order, count updates,
embedding scheduling, and post-commit maintenance notifications.

Persist the message mutation and its embedding job atomically. A job is tied to
the current searchable-text revision; workers may commit a vector only if that
revision still matches. Jobs are retried after transient failures and reclaimed
after process restart. Embedding status and user-visible run status remain
structured metadata, not text sent to the embedding model.

Run drafts and terminal outcomes use the same lifecycle boundary: completed,
interrupted, failed, and recovered output is persisted in transcript order,
with a durable status and a user-safe reason when applicable. Hard-crash
recovery must be driven by durable run state, not a `finally` block alone.

After a transcript commit, the existing process may schedule per-thread
maintenance. The transcript item limit is configurable with a default of 2,000
and remains independent of LLM context message/token caps. Before active rows
are evicted, archive their transcript content and ensure structured,
topic-grouped warm context covers the exact sequence range. Automatic boundary
moves remain topic-aware and publish the cursor with matching summaries.

Embedding and LLM calls never run inside the message transaction. Durable
work is committed first, then processed by the existing Next.js process; no
second daemon is introduced.

### Consequences

* Good, because all transcript writers share ordering, count, embedding, and
  maintenance behavior.
* Good, because restart recovery and retries no longer depend on process-local
  promises or a future opportunistic search.
* Good, because an old embedding cannot overwrite newer message text.
* Bad, because migrations, queue recovery, retry policy, and archival ordering
  add persistent state that needs focused tests.
* Bad, because the 2,000-item active limit and archived-history UI policy need
  clear configuration and user-facing behavior before eviction is enabled.

## Pros and Cons of the Options

### Best-effort embedding plus scans

* Good, because it needs little schema and runs with the current code.
* Bad, because process-local embedding work can disappear on restart and stale
  work can race deletion or edits.

### SQLite lifecycle service and durable queue

* Good, because transcript mutation and downstream work are recorded
  atomically without another process.
* Bad, because retries and in-progress work need explicit state and leases.

### Separate worker process

* Good, because expensive work can be isolated from the web process.
* Bad, because it violates the current single-process invariant and adds
  deployment and coordination complexity.

## More Information

Builds on ADR-0003 (SQLite persistence), ADR-0041 (message usage snapshots),
ADR-0044 (channel summaries), ADR-0088 (message sequence ordering), ADR-0093
(local embeddings), and ADR-0096 (exact context boundary).