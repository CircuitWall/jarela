---
status: accepted
date: 2026-06-01
deciders: example-user, claude
---

# Per-agent override of context tier split (with bar-slider UI)

## Context and Problem Statement

`context_tier_proportions` (the hot / warm / facts split that decides how the input context budget is divided across recent verbatim messages, summarised history, and facts memory) lives on the **model config**. Multiple agents using the same model share the same split. Today, varying it per agent requires cloning a model config — clunky, and it conflates "which model" with "which context shape this agent needs."

The configuration UI is also unfriendly: three percentage text inputs labelled `Hot %`, `Warm %`, `Facts %`. The backend already auto-normalises (any positive numbers work — `60/25/15` and `6/2.5/1.5` produce the same split), but the labels imply users must reconcile their inputs to 100, and they have no visual feedback on what they're configuring.

## Decision Drivers

* **Per-agent shape variation.** A research agent wants more facts; a chat agent wants more hot. Forcing model-config cloning to express that doesn't scale and gets out of sync with the actual model the user wants.
* **No "sum to 100" math.** Users shouldn't have to mentally normalise three values. Whatever UI we ship must make the constraint visible without requiring arithmetic.
* **Educate while configuring.** The split has subtle behavioural consequences. Users dragging blind will land somewhere wrong.
* **Backwards compat.** Existing agents (no override) must keep behaving exactly as they do today.

## Considered Options

* **(A) Move the column from `model_configs` to `agent_configs`.** Removes the model-level setting entirely.
* **(B) Add an override on `agent_configs` with model-level fallback.**
* **(C) Keep model-only.** Status quo.

For the UI, considered:

* **(α) Stacked-bar slider with two drag handles** — bar is always 100 by construction; user drags to redistribute.
* **(β) Named presets + Advanced toggle** — dropdown ("Recent-heavy", "Balanced", "Memory-heavy"), Advanced exposes raw inputs.
* **(γ) Rename labels + live preview** — keep three inputs, rename "Hot weight" / etc., show a normalised live strip.

## Decision Outcome

Chosen options: **(B) Per-agent override with model fallback** and **(α) Stacked-bar slider**.

(B) preserves the existing model-level setting as the default while letting individual agents diverge — least disruptive to existing data, most flexible to the variation drivers.

(α) eliminates the "sum to 100" friction by construction (the bar IS 100) and gives immediate visual feedback. Combined with an inline explainer that names each tier and the consequence of growing it, the user understands what they're doing as they drag.

### Consequences

* Good — agents can have distinct context shapes without cloning model configs.
* Good — UI removes the arithmetic burden; auto-normalisation is now visible rather than implicit.
* Good — explainer copy in the bar component teaches the user what hot/warm/facts mean to the agent.
* Good — null override = inherit, so existing behaviour is preserved unless the user actively drags.
* Bad — adds a new column to `agent_configs` (schema change, ADR trigger). Mitigated by being nullable + idempotent migration.
* Bad — when a user drags then later wants to "go back", they need an explicit "Inherit from model" affordance. Provided as a small text link next to the bar header.

## Pros and Cons of the Options

### (B) Per-agent override with model fallback (chosen)

* Good — additive: nullable column, NULL = today's behaviour.
* Good — model-level setting still useful as a tenant default for groups of agents.
* Neutral — two layers of resolution (agent → model → built-in defaults). Easy to grok; matches how `harness_id` already behaves on agents.

### (A) Move to agent_configs entirely

* Good — single source of truth.
* Bad — orphans the model-level setting; agents currently inheriting it would all need explicit values written in. Migration drift risk.

### (C) Keep model-only

* Good — zero work.
* Bad — doesn't solve either driver.

### (α) Stacked-bar slider (chosen for UI)

* Good — sum=100 by construction; user can't enter wrong values.
* Good — visual; tier sizes are immediately legible.
* Neutral — needs a small custom component (no off-the-shelf for two-thumb segmented bar).
* Bad — requires careful keyboard/aria handling for accessibility (provided).

### (β) Named presets + Advanced

* Good — fastest first-time pick.
* Bad — presets are opinionated and may not match the actual workload. Advanced toggle defers the friction rather than removing it.

### (γ) Rename labels + live preview

* Good — smallest change.
* Bad — still three inputs to coordinate; visual grokkability is much worse than a bar.

## Implementation notes

* New column `agent_configs.context_tier_proportions` (TEXT, JSON-encoded `{hot, warm, facts}`). NULL = inherit from `ModelConfig.params.context_tier_proportions` (which itself falls back to the built-in 60/25/15 default).
* Resolution happens in `prepareThreadRun`: when the agent has an override, it overlays onto a copy of `providerParams` before `buildHistoryWindow` consumes it. The actual LLM stream call uses the unmodified params.
* `getAgentTierProportions` validates the JSON and returns `null` on any malformed payload — defensive against the column being externally edited.
* The bar component lives in `components/agents/TierProportionBar.tsx`, used inline in the AgentEditor's Advanced section. It renders an explainer block beneath the bar that names each tier and the consequence of growing it.
* Cross-references: ADR-0042 (per-thread context pin — orthogonal lever; this PR controls the *cap sizes*, that ADR controls *what enters which tier*). The model-level setting at [components/models/ModelEditor.tsx](components/models/ModelEditor.tsx) is unchanged; replacing its 3-text-input UI with the bar component is a follow-up.
