---
status: "accepted"
date: 2026-06-01
deciders: andrew
---

# Snapshot per-message LLM usage into an immutable table

## Context and Problem Statement

Dashboard metrics (tokens, $ cost, per-agent / per-provider / per-model
breakdowns) are computed at query time by
[`getDashboardMetrics`](../../lib/stores/dashboard-metrics.ts) joining
`messages` → `threads.agent_id` → `agent_configs.model_config_name` →
`model_configs.provider/model_id`, then estimating tokens from
`messages.content.length` and applying current pricing from
`docs/journal/pricing-snapshot.json`.

That makes every historical number **mutable**:

- Reassign an agent's model → past messages get re-attributed to the new
  provider/model and recosted at the new rates.
- Edit a model config's `provider` or `model_id` → same.
- Delete an agent or a model config → `LEFT JOIN` collapses past rows
  into "unknown".
- Refresh the pricing snapshot → every historical $ figure shifts.
- Token counts are heuristic (`Math.ceil(content.length / 4)`) even though
  providers already return real `usage_metadata` that we discard after the
  stream ends.

The user wants the dashboard to be "reliable" — values should be derivable
from immutable recorded facts, not recomputed against ever-shifting joins.

## Decision Drivers

- **Immutability of historical reporting**: editing a model config or
  reassigning an agent must not retroactively rewrite past cost/token
  numbers.
- **Real token counts**: providers already return them; we should record
  them instead of estimating from string length.
- **Stable attribution under deletion**: if the user deletes an agent or
  model config, the historical aggregates by that agent/model must remain.
- **Bounded scope**: don't try to backfill the past. Old messages stay on
  the estimate path; new messages use the snapshot path.

## Considered Options

1. **Snapshot per assistant turn into a sibling table (`message_usage`)**
   keyed by `msg_id`. Dashboard prefers the snapshot when present, falls
   back to the estimate for pre-migration rows.
2. **Add columns directly to `messages`**. Same data, but every old row
   gets NULL columns and we lose the clean "this turn was recorded under
   the new pricing regime" boundary.
3. **Computed view over `messages` + `message_usage`** that exposes a
   single virtual table. Adds indirection without changing the storage
   trade-off.
4. **Append-only event log** (`llm_usage_events`) decoupled from
   `messages`. More flexible, but the only consumer is the dashboard and
   the 1:1 relationship to assistant messages is real.

## Decision Outcome

Chosen option: **(1) sibling `message_usage` table** keyed by `msg_id`.

```sql
CREATE TABLE message_usage (
  message_id              TEXT PRIMARY KEY REFERENCES messages(msg_id),
  thread_id               TEXT NOT NULL,
  agent_id                TEXT NOT NULL,        -- snapshot
  agent_name              TEXT NOT NULL,        -- snapshot
  provider                TEXT NOT NULL,        -- snapshot
  model_id                TEXT NOT NULL,        -- snapshot
  model_config_name       TEXT,                 -- snapshot
  input_tokens            INTEGER NOT NULL,     -- real, from provider
  output_tokens           INTEGER NOT NULL,
  input_rate_usd_per_mtok REAL,                 -- snapshot of pricing
  output_rate_usd_per_mtok REAL,
  cost_usd                REAL NOT NULL,        -- precomputed at write time
  created_at              TEXT NOT NULL
);
CREATE INDEX message_usage_created_at ON message_usage(created_at);
CREATE INDEX message_usage_agent_id   ON message_usage(agent_id);
```

Rows are written exactly once, immediately after the assistant turn is
persisted to `messages`. Nothing in the app updates them after.

The dashboard query `LEFT JOIN`s `message_usage` onto `messages`. For
assistant rows that have a snapshot, the snapshot is authoritative
(tokens, attribution, $ cost). For older rows without one, the current
estimate path continues to apply.

### Consequences

- Good: reassigning an agent's model, renaming a model config, or
  refreshing the pricing snapshot has zero effect on rows already
  recorded.
- Good: dashboards become a pure `SUM(...) GROUP BY` over the snapshot
  table — no joins through `agent_configs` / `model_configs` for any
  data point that has a snapshot.
- Good: real token counts (the provider already gives us the number).
- Bad / accepted: pre-existing messages stay on the estimate path
  forever. We don't have the data to backfill them.
- Bad / accepted: a small write per assistant turn (one INSERT).

## Pros and Cons of the Options

### (1) Sibling `message_usage` table

- Good: clean migration boundary (no NULL columns on old rows).
- Good: 1:1 with `msg_id` makes joins / FKs trivial.
- Neutral: requires updating the 5 call sites that persist assistant
  messages to also persist usage.

### (2) Columns on `messages`

- Good: one table.
- Bad: half-populated columns on every existing row; "no snapshot" is
  ambiguous with "zero tokens".

### (3) Computed view

- Good: read-side abstraction.
- Bad: same storage as (1), extra moving part.

### (4) Append-only event log

- Good: future-proof if we ever record non-message usage (e.g. embedding
  calls, tool-internal LLM calls).
- Bad: today there's exactly one consumer and exactly one event-per-turn;
  the indirection is unjustified speculation.

## Implementation notes

- Provider stream events already include `{ type: "usage", input_tokens,
  output_tokens, ... }` ([`lib/providers/types.ts`](../../lib/providers/types.ts)).
  The chat model forwards them onto the final `AIMessageChunk` via
  `usage_metadata` (LangChain's standard shape), `lib/agents/llm.ts`
  accumulates across the multi-step react loop, and the `done` chunk
  carries the totals.
- `persistAssistantMessage` (`lib/agents/run-thread.ts`) accepts an
  optional `usage` argument and inserts the snapshot row inside the same
  call as `addMessage`.
- For the dashboard read path: when `message_usage` is present for the
  assistant row, use it as the sole source of truth for tokens, cost,
  provider, and model attribution for that turn. The user-message row's
  `input_tokens` estimate is suppressed when its following assistant turn
  has a snapshot (avoids double-counting input).
