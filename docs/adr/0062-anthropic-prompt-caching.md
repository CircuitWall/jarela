---
status: accepted
date: 2026-06-05
deciders: Andrew Wu
---

# Anthropic prompt caching, end-to-end

## Context and Problem Statement

A 2026-06-05 cost incident showed a single Developer-style agent on
Opus 4.7 burning ~$43/day with the bulk of spend concentrated in
multi-step ReAct turns where the same system prompt + tool schema +
tool result history was re-sent on every step of the inner loop. The
provider supports prompt caching (Anthropic exposes
`cache_control: {type: "ephemeral"}` markers on `system`, `tools`, and
selected message blocks; cache reads bill at 0.1× input, cache writes
at 1.25×), but the in-tree adapter wasn't using it. Without caching,
N-step turns paid the full input cost on every step.

Closing this gap had three independent parts that needed to land
together to be useful:

1. **Wire-level caching** — emit `cache_control` markers so the
   provider can hit/write the cache.
2. **Per-turn token accounting** — surface
   `cache_creation_input_tokens` / `cache_read_input_tokens` from the
   provider response into the per-turn `message_usage` snapshot, so
   the dashboard's $/token math is correct (otherwise the dashboard
   *under*reports cost on cache-creating turns and *over*reports on
   cache-hitting turns).
3. **Wire response** — pass the cache breakdown through the GET
   `/api/v1/threads/<id>` projection so the chat UI can render a
   "served from cache" badge in a follow-up without another wire
   change.

This ADR captures the load-bearing decisions made across PR #181
(wire-level caching), PR #183 (token accounting + cost math), and PR
#185 (wire response shape).

## Decision Drivers

* **Cost reduction must be measurable, not just real.** Caching that
  fires on the wire but isn't visible in the dashboard is operationally
  useless — operators need to verify the savings before trusting the
  feature.
* **Schema evolution must be additive and reversible.** Legacy rows
  predate caching; the migration must leave them untouched and
  consumers must tolerate `null` cache columns.
* **No provider-specific contract leaks into the agent layer.** The
  agent loop and `message_usage` row don't need to know that 1.25× /
  0.1× are Anthropic-specific multipliers — those constants live in
  the pricing module behind a generic interface.
* **LangChain compatibility.** The chat-model abstraction
  (`JarelaChatModel`) must surface cache tokens through LangChain's
  standard channel (`usage_metadata.input_token_details`) so any
  future LangChain-aware consumer (e.g. callbacks, tracers) sees them.

## Considered Options

### Where to store cache tokens

* **Option A — Inline into `input_tokens`.** Roll cache reads and
  writes into the existing `input_tokens` column. Reflects "total
  billable input" but loses the breakdown.
* **Option B — Two new nullable columns.** Add
  `cache_creation_input_tokens` and `cache_read_input_tokens` to
  `message_usage`. Disjoint from `input_tokens`. Legacy rows and
  non-Anthropic providers leave them `NULL`.

### How to plumb cache tokens through the agent layer

* **Option A1 — Bespoke `cacheUsage` channel.** Add a
  `cacheUsage: { creation, read }` field to the `done` chunk's
  `usage` payload, parallel to `input_tokens` / `output_tokens`.
* **Option A2 — LangChain `input_token_details` channel.** Forward
  cache tokens through `usage_metadata.input_token_details.{cache_read,
  cache_creation}` — the channel LangChain documents for this exact
  purpose ([metadata.d.ts]).

### How to bill cache tokens

* **Option B1 — Hardcode `1.25` and `0.1` inline at the call site
  in `run-thread.ts`.** Simple, but couples the agent layer to
  provider-specific pricing.
* **Option B2 — Extend `estimateCostUsd` with a `cache?` arg and
  define `CACHE_CREATION_INPUT_RATE_MULTIPLIER` /
  `CACHE_READ_INPUT_RATE_MULTIPLIER` constants in the pricing
  module.** Centralises the multipliers; the agent layer just passes
  the raw counts through.

## Decision Outcome

| Concern         | Choice    | Rationale                                                                                                                                      |
|-----------------|-----------|------------------------------------------------------------------------------------------------------------------------------------------------|
| Storage         | **Option B** | Keeping `input_tokens` as "fresh, non-cached input" preserves the existing semantic and matches Anthropic's API ordering directly.            |
| Plumbing        | **Option A2** | LangChain's standard channel is documented for exactly this use, and using it means tracers/callbacks Just Work with no extra wiring.        |
| Billing         | **Option B2** | Multipliers are a pricing concern, not an agent-loop concern; centralising them in `lib/stores/pricing.ts` keeps the layering clean.        |

The cache breakpoints chosen on the wire side (PR #181) are:

1. **System block.** The system prompt + tool definitions are
   stable across the entire ReAct loop within a turn — and across
   turns until the agent's instructions change.
2. **Tools block.** Marked because the tool catalogue is large
   relative to the message history on early turns.
3. **Last tool-result message.** Cuts the ReAct re-send cost: each
   step in a multi-step turn re-runs the model with the prior
   tool-result blocks, which the cache can reuse.

Three breakpoints is also Anthropic's documented limit at the time of
writing.

### Consequences

* **Good** — Per-turn `cost_usd` now reflects actual provider billing
  for cache-creating turns (1.25× the fresh input rate on cache writes,
  0.1× on cache reads). The dashboard total is correct end-to-end.
* **Good** — Plug-in providers that adopt the same convention
  (emitting `cache_creation_input_tokens` / `cache_read_input_tokens`
  on the `usage` event) get correct cost attribution for free.
* **Good** — The schema migration is additive. Legacy rows surface as
  `NULL`; `messageUsageToResponse` exposes them as nullable numbers.
* **Bad** — `input_tokens` semantics now diverge slightly between
  Anthropic and non-cache-aware providers: for Anthropic, total
  billable input = `input_tokens + cache_creation + cache_read`; for
  others, total billable input = `input_tokens`. The cost math handles
  this correctly because cache fields default to 0, but downstream
  consumers that only sum `input_tokens` will under-count Anthropic
  totals.
* **Bad** — OpenAI's prompt caching surfaces only `cached_tokens` (no
  separate write count), so applying these multipliers verbatim to
  OpenAI would be incorrect. The pricing module is structured to make
  per-provider overrides easy, but no override is in place yet.

## Pros and Cons of the Options

### Storage — Option A (inline)

* Good — simpler aggregation queries (one column to sum).
* Bad — irreversible: once collapsed, can't un-mix the components for
  audit. The dashboard could no longer show "your cache is saving you
  $X this month."

### Storage — Option B (two new columns) — chosen

* Good — preserves the breakdown for analytics and UI.
* Good — additive migration; no behaviour change for legacy rows.
* Neutral — slight schema bloat (two extra nullable INTEGER columns
  per assistant turn).

### Plumbing — Option A1 (bespoke channel)

* Good — explicit and readable at the call site.
* Bad — anything else watching the `done` chunk needs to opt in
  separately. Tracers/callbacks attached via LangChain don't see it.

### Plumbing — Option A2 (`input_token_details`) — chosen

* Good — LangChain's documented channel; tracers/callbacks benefit.
* Good — `mergeUsageMetadata` from LangChain core handles
  accumulation across the ReAct loop with no custom logic.
* Neutral — convention requires reading
  `usage_metadata?.input_token_details?.cache_*`; small overhead.

### Billing — Option B1 (inline multipliers)

* Good — local; no indirection.
* Bad — hardcodes Anthropic's pricing model in
  `lib/agents/run-thread.ts`, which has no other Anthropic-specific
  knowledge. Future providers with different multipliers would
  require if/else branches in agent code.

### Billing — Option B2 (constants in pricing) — chosen

* Good — centralises pricing decisions in the module that owns them.
* Good — `estimateCostUsd` becomes the single seam for future
  per-provider overrides.
* Neutral — one extra arg on the function signature.

## Follow-ups

* **Surface "served from cache" in the chat UI.** The wire data
  exists (PR #185); a small ContextUsageBar variant that highlights
  cache reads is the natural next step.
* **OpenAI cache pricing override.** When OpenAI's adapter emits a
  cache-token breakdown, factor `estimateCostUsd` so per-provider
  multipliers can override the Anthropic defaults.
* **Stale-cache GC.** Anthropic ephemerals expire after 5 minutes of
  no-hit; long-running agents that pause across that window pay the
  fresh-input rate on the next call. Worth measuring before deciding
  whether to add a refresh.
* **Cache-hit-rate dashboard widget.** With per-turn data persisted,
  a simple `SUM(cache_read_input_tokens) / SUM(cache_read_input_tokens + cache_creation_input_tokens + input_tokens)`
  per agent gives an at-a-glance "is caching actually firing for this
  agent" answer.

[metadata.d.ts]: ../../node_modules/@langchain/core/dist/messages/metadata.d.ts
