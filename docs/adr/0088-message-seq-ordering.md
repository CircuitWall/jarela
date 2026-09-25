---
status: "accepted"
date: 2026-09-25
deciders: Andrew Wu
---

# 0088 - Order and paginate messages by seq (rowid), not created_at

## Context and Problem Statement

`fecb9090` ("prevent timestamp collisions") patched a real bug — two
messages persisted within the same millisecond sorted ambiguously — by
adding a `created_at, msg_id` tie-break plus a millisecond-bump hack in
`addMessage`. That fixed in-process ordering but left two problems: the
bump hack mutates a wall-clock field for a structural reason (masking it
for any other reader of `created_at`), and the client-side reconcile sort
in `appendUnique` (`components/chat/chat-helpers.ts`) still sorted
optimistic/confirmed messages by `created_at` string comparison, which is
inherently fragile across client/server clocks. How should messages be
ordered and paginated so a burst of same-millisecond writes, and
client/server clock differences, can never produce an ambiguous or
skewed order?

## Decision Drivers

* Message order must be unambiguous even when many messages are persisted
  within the same millisecond (fast tool-loop turns, automation activity).
* The client's optimistic-append reconciliation must not depend on
  client/server clock agreement.
* Prefer the smallest change that removes the ambiguity — no schema
  migration if one isn't needed.

## Considered Options

* Add an explicit `seq INTEGER` column with a backfill migration.
* Use SQLite's native `rowid` (implicit monotonic insertion-order integer
  on every rowid table) as the ordering/pagination key.
* Keep `created_at` as the key and extend the collision-avoidance hack
  further (e.g. sub-millisecond padding).

## Decision Outcome

Chosen option: **SQLite's native `rowid`**, exposed as `MessageRow.seq` /
wire `Message.seq`. It is already unique and strictly increasing per
insert, so no migration or backfill is needed — `lib/stores/automation-activity.ts`
was already relying on it (`ORDER BY rowid DESC`) before this ADR, which
confirmed the pattern is safe and idiomatic in this codebase.

Changes:
- `lib/stores/threads.ts`: all message reads/deletes order by `rowid`;
  `addMessage`'s millisecond-bump hack is removed — `created_at` is pure
  wall-clock again.
- `getMessagesAfter`/`getMessagesPage` cursors (`before`/`after`) changed
  from ISO-timestamp strings to numeric `seq` values. `pruneThreadMessages`'s
  `preserveSince` (a created_at string) became `preserveFromSeq` (a `seq`
  cursor) for the same reason.
- `GET /api/v1/threads/[thread_id]`'s `before`/`after` query params follow
  the same change — a breaking change to an already-shipped v1 endpoint.
- `api/types.ts` `Message.seq?: number` — optional because client-only
  optimistic bubbles don't have one until the server confirms them.
- `components/chat/chat-helpers.ts` `appendUnique` now sorts by `seq`
  (unconfirmed messages, lacking one, sort last via `+Infinity`, with
  `Array.sort`'s stability preserving relative order among them).
- `components/chat/useThreadCrossDeviceSync.ts`: the forward-fetch anchor
  is the last *confirmed* message's `seq` (an unconfirmed one has none
  yet); losing the anchor now falls back to merging via `appendUnique`
  instead of overwriting the local message list, so a still-pending local
  send can no longer be dropped by a cross-device refresh.
- The bump hack also implicitly protected `lib/agents/thread-compaction.ts`
  and `lib/agents/warm-summary-background.ts`'s `findTopicBoundary` /
  `compactThreadWarmContext`, which pick a compaction boundary as an exact
  created_at value and then filter rows against it — removing the bump
  reopened the exact same collision there, just as a destructive one (a
  row tied with the boundary fails `<`, so it's skipped by both the
  summary and the prune delete, under-pruning). Fixed by cutting on the
  boundary row's exact `seq` instead: `findTopicBoundary` now returns
  `{ created_at, seq }` instead of a bare string; `compactThreadWarmContext`
  accepts an optional `requestedBoundarySeq` and returns a matching
  `boundarySeq` in `CommittedWarmContext`; `thread-compaction.ts`'s
  `compactAgentThread` passes the row it picked by array index and prunes
  on `context.boundarySeq` rather than re-deriving a row from the
  created_at label (which, when several rows tie, would silently match
  the *first* of the tied group instead of the intended one).

### Consequences

* Good, because message order can no longer be ambiguous, regardless of
  how many messages land in the same millisecond.
* Good, because `created_at` is simple wall-clock again — no more
  structural writes to it disguised as timestamps.
* Good, because no schema migration was needed.
* Bad, because it's a breaking change to the `GET /api/v1/threads/[thread_id]`
  `before`/`after` contract — bump accordingly at the next release.
* Neutral, because `rowid` is SQLite-specific; this store already assumes
  SQLite throughout, so it adds no new coupling.
* Neutral, because the automatic boundary paths (`kickBoundaryCompaction`/
  `refreshWarmSummary`) never call `pruneThreadMessages`, so their
  created_at-only boundary (no row-derived seq available at those call
  sites) keeps the pre-existing, non-destructive approximate-tie behavior
  — a tied row there stays visible in the hot window an extra turn rather
  than losing data.

## More Information

Supersedes the tie-break/bump-hack fix from `fecb9090` ("fix(threads):
prevent timestamp collisions").
