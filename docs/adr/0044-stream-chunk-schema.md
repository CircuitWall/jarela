---
status: accepted
date: 2026-06-02
deciders: andwu, claude
---

# Single zod schema as the contract for streamed agent events

## Context and Problem Statement

The agent run pipeline emits a stream of events from the LangGraph loop, through the in-memory run-registry, out as SSE on `/api/v1/threads/:id/run`, and into the chat reducer in `useSSE`. The shape of those events was previously declared in two places:

- `lib/agents/base.ts#StreamChunk` — the server-internal envelope `{type, data}`.
- `api/types.ts#SSEEventType` — the flat wire shape `{type, ...payload}` the route flattens to before the SSE write.

Both were hand-typed unions kept in sync by convention. The client-side `useSSE` consume loop also did `JSON.parse(raw) as SSEEventType` with no runtime check, so any drift between server emit and client expectations corrupted streaming state silently. With "reliably handle long, complex tasks" as the new product directive, silent corruption mid-task is a worst-case failure: the user has invested 50 turns in a goal and the chat reducer drops or mis-renders an event because someone added a field server-side that the client doesn't know about.

## Decision Drivers

* **One source of truth.** Two declarations of the same thing drift. We've already had divergence (`done` payload had `usage` in one shape and the other lacked the optional `aborted: true` flag).
* **Loud failure on drift.** A version-skewed client should refuse the event with a logged warning, not crash the reducer or silently apply defaults.
* **Don't break existing tests.** 1002 tests exist; the change must be additive at the type level.
* **Performance is not a concern here.** zod safeParse on ~30 events per turn is negligible.

## Considered Options

* **(A) Keep two hand-typed unions; add a hand-written runtime guard.** Lowest churn, doesn't actually solve drift.
* **(B) Hand-typed unions with a comment "keep in sync".** Status quo.
* **(C) Single zod schema; derive both types from it; safeParse at boundaries.** Schema-first.

## Decision Outcome

Chosen: **(C) Single zod schema** in `lib/agents/stream-chunk-schema.ts`.

The schema declares per-type *payload* shapes once, then composes two discriminated unions:

- `StreamChunkSchema` — the server-internal envelope with `{type, data: payload}`.
- `SSEEventSchema` — the flattened wire shape `{type, ...payload}`, plus the `run_in_flight` event the route emits directly.

`api/types.ts#SSEEventType` becomes a re-export of the zod-inferred type so client code can no longer drift from the schema. The server emit path stays untyped at construction (it casts `Record<string, unknown>` for `data`, matching today's emit-site code) but consumers can opt into strict parsing via `safeParseStreamChunk`.

`useSSE` is the first hardened consumer — every inbound event is `safeParseSSEEvent`-checked, with a `console.warn` and skip on failure. This makes long-task reliability incrementally better without forcing a server-side cutover; the server can keep emitting what it emits today and only future server changes that violate the schema fail loudly.

### Consequences

* Good — schema drift between server emit and client consume now produces a logged warning, not a silent corruption.
* Good — `SSEEventType` and `StreamChunk` cannot diverge: both derive from the same zod schemas.
* Good — adding a new event type touches one file. The schema update fails the type checker on every consumer that hasn't handled the new variant.
* Bad — zod adds ~30µs/event of parse overhead. Negligible at our event volume.
* Bad — older docs and code comments referencing "the StreamChunk type" need updating over time. Acceptable churn.
* Mitigation — `safeParseSSEEvent` returns null on failure rather than throwing; the consumer logs and continues, so a regression on one event type doesn't kill the whole stream.

## Pros and Cons of the Options

### (C) Single zod schema (chosen)

* Good — one source of truth; drift impossible by construction.
* Good — runtime validation is a free byproduct of the schema definition.
* Good — defensive parse is opt-in per consumer; existing emit code untouched.
* Neutral — adds a runtime dependency on zod (already in package.json).

### (A) Two unions + a hand-written runtime guard

* Good — no schema library.
* Bad — guard inevitably drifts from the type. We've already seen this with the `done.usage` field shape.

### (B) Status quo

* Good — zero work.
* Bad — every silent corruption mid-task costs the user a long turn's worth of effort. Unacceptable for the long-task directive.

## Implementation notes

* `lib/agents/stream-chunk-schema.ts` defines per-type payload schemas, then composes `StreamChunkSchema` (server envelope) and `SSEEventSchema` (flat wire). Exports `safeParseStreamChunk` and `safeParseSSEEvent` for defensive parsing.
* `hooks/useSSE.ts` uses `safeParseSSEEvent` on every inbound event. Failures are `console.warn`-logged and the event is skipped — the chat reducer keeps working on subsequent valid events.
* `api/types.ts#SSEEventType` becomes `export type { SSEEventParsed as SSEEventType }`. No callers change.
* Server-side emit sites (`lib/agents/llm.ts`) are untouched in this ADR — they continue to construct `{type, data}` objects whose `data` is typed as `Record<string, unknown>`. A future ADR can tighten that to require schema parsing at emit time once we're confident no edge cases survive.
* Cross-references: ADR-0008 (single-transport agent run lifecycle, defines POST + GET semantics this schema lives within); PR-#122/123 added run-registry watchdogs, this ADR addresses the orthogonal concern of *what* the registry transports.
