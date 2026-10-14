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
Warm output uses validated topic recaps newest-first; if the cap cuts through a
topic, the stored recap is marked partial and starts at the first source row.
Older transcript remains stored and searchable through message recall; it is
not accumulated into the warm summary.

The summary preview renders persisted topic segments as expandable rows with
short recap previews, rather than duplicating them as flat prose. Stored topic
grouping remains visible when the summary is stale, alongside the stale-focus
warning. Summaries without structured topic data retain the prose fallback.

Existing agents receive the default through an additive SQLite migration.
`history_limit` continues to control the raw history window and retains its
existing zero-means-unlimited behavior.

All automatic, manual, and retention compaction requests use the shared
topic-aware boundary coordinator. Hot-turn overflow and near-budget hot-token
pressure may trigger it; `warm_summary_limit` only caps its result and does not
trigger another compaction.

## Consequences

* Warm context can be tuned independently from raw history and hot-turn caps.
* Large transcript histories do not force large warm summaries by default.
* Disabling warm summaries does not delete transcript rows or their embeddings.