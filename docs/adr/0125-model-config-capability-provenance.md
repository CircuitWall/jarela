# ADR-0125: Keep catalog capability numbers out of saved model configs

Status: **Accepted**

Date: 2026-11-20

Related: [ADR-0067](./0067-context-window-discovery-and-self-correct.md)
(context window discovery), [ADR-0092](./0092-global-usage-strategies.md)
(output ceilings), [ADR-0003](./0003-sqlite-local-persistence.md).

## Context

The Models panel used to copy the picked catalog row's sizing straight into the
saved configuration: `params.context_window_tokens` from `context_length` and
`params.max_tokens` from `max_output_tokens`
(`applyCatalogPick` in `components/models/model-editor/ModelIdSection.tsx`).

That turned a suggestion into something the runtime treats as a user decision.
`run-thread` computes the per-turn ceiling as

```
min(context remaining, known model output limit, explicit params.max_tokens)
```

so a stamped `max_tokens` wins forever. When `6468c2e6` raised DeepSeek's V4
limits from 65,536/8,192 to 1M/384K, every config created before it kept
sending 8,192 — a 1M-token model generating 8k tokens, with nothing in the UI
explaining why:

- the field showed the number as if the user had typed it (the
  "(catalog default)" hint only existed inside the same editing session);
- nothing compared a saved value against the model's current limit;
- the legacy id (`deepseek-v4-flash`) had also dropped out of the provider
  catalog, so there was no row left to re-pick.

Measured on a live install: `deepseek-v4-flash` was configured with
`max_tokens: 8_192` and `context_window_tokens: 65_536` while the model's
current limits are 393,216 output and 1M context.

## Decision

1. **The picker suggests, never persists.** `applyCatalogPick` records the
   catalog's sizing as a hint (placeholder plus a "Model limit" line under the
   field) and leaves the inputs empty. Empty means automatic, which the runtime
   re-resolves from `getKnownMaxOutputTokens` / `getKnownContextLength` on every
   turn. The editor also shows the curated table's limit when no catalog row was
   picked, so a user can see the model's capability without leaving the app.
2. **Superseded snapshots are ignored.** `stripSupersededLimits` in
   `lib/providers/known-context-windows.ts` lists the exact context/output pairs
   Jarela stamped from earlier catalog data and drops them. It matches the pair
   — not a single field — so a config that pins only `max_tokens` keeps that
   deliberate cap. Applied at three boundaries:
   - `getModelParams` (every runtime consumer: turns, probes, summaries);
   - `upsertModelConfig` (the row is cleaned on its next save);
   - the models API responses (the editor shows automatic, not the snapshot).

## Consequences

- New and edited configs carry only user intent; capability numbers come from
  the current catalog or curated table at call time.
- A user who deliberately pins a lower output cap keeps it, and the field now
  says so ("The model supports N output tokens; this lower cap is used as set").
- `ADR-0067` context discovery still runs at save time for models the curated
  table does not know; it writes the *current* value, and the stale-pair rule
  covers the values Jarela itself wrote in the past.
- The superseded list is data, not a migration: it is evaluated on read, so a
  config heals whether or not the user ever opens the editor, and no encrypted
  row has to be rewritten before the master key is unlocked.

## Validation

- `lib/providers/known-context-windows.test.ts`: the stale pair is dropped, a
  deliberate single-field cap is kept, other providers/models are untouched.
- `lib/stores/model-config.test.ts`: a legacy-shaped row resolves without the
  pair, a deliberate cap survives, and a save removes the pair from storage.
- `lib/agents/run-thread.auto-boundary.test.ts`: a config carrying
  65,536/8,192 for `deepseek-v4-flash` prepares a turn with 393,216 output and
  the model's real context window (800,000 under Balanced).
- `components/models/model-editor/catalog-pick.test.tsx`: a catalog pick sets
  the suggestions and never writes `max_tokens` / `context_window_tokens`.
