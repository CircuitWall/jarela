---
status: accepted
date: 2026-10-15
deciders: Jarela maintainers
---

# Enable/disable model configs and set the default atomically

## Context and Problem Statement

Users want to remove a model from selection for a while, for example during a provider outage or while a quota is exhausted, without deleting it and losing its credentials and tuned params. The only way to hide a model was to delete it.

Setting the default model was not atomic either. The UI sent a full `PUT /api/v1/models/[name]` with the model's redacted params and `is_default: true`. That rewrote params, could trigger context-window discovery, and on other edits defaulted an omitted `is_default` to `false`, which silently unset the default.

## Decision

* **Schema.** Add `model_configs.enabled INTEGER NOT NULL DEFAULT 1`. Existing rows stay enabled. The additive migration lives in `ensureModelConfigEnabledColumn` in `lib/db/migrations.ts`.
* **State endpoint.** `PATCH /api/v1/models/[name]` accepts `{ enabled?, is_default?: true }`. Each change runs in a single transaction in `lib/stores/model-config.ts` and never touches params:
  * `setDefaultModelConfig` clears every other default and sets this one. A disabled model cannot become the default (409).
  * `setModelConfigEnabled(false)` clears the model's default flag and promotes the alphabetically first other enabled model. Disabling the last enabled model is rejected (409), so the workspace always has a runnable default.
* **Upserts preserve state.** An omitted `is_default` keeps the existing flag, and `enabled` is always preserved. `is_default: true` on an upsert re-enables the row, so a default is never disabled.
* **Runtime resolution.** `getDefaultModelConfig`, `resolveRunnableModelConfig`, the heuristic router candidates, thread model snapshots, and warm-summary jobs consider only enabled models. An agent explicitly bound to a disabled model keeps its binding but runs on routing or the default until the model is re-enabled. The client mirror is `resolveAgentModel` in `lib/agents/effective-model.ts`.
* **UI.** The Models panel has a power toggle per model, dims disabled rows with a "disabled" badge, hides "Set as default" on them, and sets the default through `PATCH`. The agent model override picker lists only enabled models, plus the current selection marked "(disabled)".

## Out of Scope

Secondary, explicitly configured model selections keep their current behavior and do not check `enabled`: the embedding model, citation checker, hallucination classifier model, pricing extraction, thread compaction, and dashboard metrics. These are opt-in settings that name a model directly. Disabling a model is about the chat model selection.

## Consequences

* Disabling is reversible and keeps credentials, params, and agent bindings.
* Clients must handle 409 from `PATCH` (disabling the last enabled model, or defaulting a disabled one).
* `GET /api/v1/models` rows gain `enabled: boolean`.
