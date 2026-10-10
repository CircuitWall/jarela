---
status: accepted
date: 2026-10-09
deciders: Jarela maintainers
---

# Exact thread context boundary and warm-context service

## Context and Problem Statement

The hot/warm boundary is persisted as a timestamp, while message ordering and
pagination use SQLite `rowid` (`seq`) because timestamps can collide. The chat
UI re-derives the boundary row from that timestamp, and several compaction paths
update the chat summary without refreshing every channel summary. These paths
can disagree about which source message is the boundary or which summaries
cover it.

## Decision Drivers

* Use the same source row for prompt assembly, summary coverage, rendering, and
  locate behavior.
* Keep boundary state durable across reloads and server restarts.
* Keep one thread per agent as the current ownership model without making the
  persisted cursor depend on that implementation detail.
* Preserve the existing timestamp API fields for display and compatibility.
* Never publish a narrower hot window without the corresponding warm context.

## Considered Options

* Keep timestamps authoritative and add tie-breaking rules at each caller.
* Persist a thread-scoped `seq` cursor and centralize boundary/context access.
* Store boundary and warm summaries in process-local agent state.

## Decision Outcome

Accepted: persist the exact boundary cursor on the thread and use one
thread-context service for boundary transitions and warm-context retrieval.

The persisted cursor marks the earliest message eligible for hot context.
Persist its exact `seq` as `hot_since_seq`; retain `hot_since` as a
display-only field. The inclusive rowid lower bound does not bypass the
configured message limit, hot-turn limit, or token budget, which can further
narrow the messages actually sent to the model. When no pin is set, the
configured history window supplies the time bound. Persist matching
`warm_summary_before_seq` and per-channel `summary_before_seq` values. The
cursor is keyed by `thread_id`, not `agent_id`, so separate or future agent
threads cannot share context state.

Timestamp-only boundary mutations are rejected. On upgrade, legacy pins whose
exact cursor is unknowable are cleared and their old summary coverage is
ignored; the configured history window applies until the user sets a new pin.
Legacy timestamps are never converted back into row identities.

The route validates that a requested cursor belongs to the thread. For a
non-null user move, it returns the current committed state and a pending cursor
while background compaction runs. Compaction may align the requested cursor to
a nearby topic start, then builds the chat recap and automation channel
summaries. A compare-and-set transaction publishes the chosen cursor and
matching coverage cursors together. A failed preparation leaves the current
committed boundary unchanged; a compare-and-set rejection leaves any newer
committed state intact. Overlapping requests are queued with the latest
request taking precedence. Clearing the pin is immediate because it broadens
context and needs no replacement recap. The UI polls thread metadata until the
pending cursor settles.

Warm-context reads return only summaries whose exact coverage cursor matches
the effective boundary and requested channels. Missing automation summaries
are omitted from that turn rather than generated inline. Automatic, manual,
and retention compaction use the same service; retention pruning uses the
committed cursor.

The chat divider and message DOM ids use the source message's `seq`. Drag
selection, counts, anchor relocation, and Locate resolve that same source row;
timestamps remain presentation data and never select the boundary row.

### Consequences

* Good, because same-millisecond messages cannot make the UI, prompt, and
  summary disagree about the boundary.
* Good, because a single service can keep all compaction paths aligned.
* Bad, because existing timestamp-only pins cannot be preserved without
  guessing a source row; those pins are cleared once during migration.
* Bad, because boundary moves may wait for all required channel summaries
  before committing.

## More Information

* Builds on ADR-0042 (thread context pin), ADR-0044 (channel-scoped warm
  summaries), and ADR-0088 (message `seq` ordering).
* Replaces timestamp equality as the freshness key for boundary summaries.