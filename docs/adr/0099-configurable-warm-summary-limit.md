---
status: accepted
date: 2026-10-10
deciders: Jarela maintainers
---

# Configure the warm summary window

## Context and Problem Statement

The warm summary is the bounded context between recent verbatim history and
cold transcript recall. Reusing `history_limit` for its size couples two
different policies, and an unlimited raw-history setting must not create an
unbounded summary.

## Decision

Add a per-agent `warm_summary_limit`, measured in transcript messages. It
defaults to 50, accepts nonnegative values, and zero disables warm summaries.
The configured value is also bounded by the existing prompt-character budget.
Older transcript remains stored and searchable through message recall; it is
not accumulated into the warm summary.

Existing agents receive the default through an additive SQLite migration.
`history_limit` continues to control the raw history window and retains its
existing zero-means-unlimited behavior.

## Consequences

* Warm context can be tuned independently from raw history and hot-turn caps.
* Large transcript histories do not force large warm summaries by default.
* Disabling warm summaries does not delete transcript rows or their embeddings.