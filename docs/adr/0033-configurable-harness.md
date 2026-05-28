---
status: "accepted"
date: 2026-05-28
deciders: example-user
---

# ADR-0033: Configurable harness (sectional, global default + per-agent override)

> **Extended by [ADR-0036](0036-agent-driven-harness-edits.md)** — agent-driven edits to custom harnesses (and switching an agent's `harness_id`) are now permitted via the approval flow. Built-ins remain read-only and the global default pointer stays UI-only.

## Context and Problem Statement

The system prompt sent to the LLM on every turn is assembled in
[lib/agents/run-thread.ts](../../lib/agents/run-thread.ts) from per-agent
`identity` + `instructions` plus five hard-coded module constants —
`CAPABILITIES_CTX`, `PLAN_FIRST_CTX`, `PRESENTATION_CTX`,
`CITATION_CTX`, `SELF_CONFIG_CTX`. Together these constants form the
app's **harness**: the behavioural scaffolding that shapes how every
agent on this instance acknowledges, formats, cites, and proposes
config changes.

The harness is currently invisible from the UI and identical for every
agent. Users who want a research agent with stricter citation rules, or
a companion agent with looser formatting, have no way to express that
without editing source. We want the harness to be a first-class config
object: globally tunable, per-agent overridable, with curated presets.

## Decision Drivers

* Treat the harness as data, not code, so the UI can show and edit it.
* Allow per-agent variation without forcing every agent to override —
  the global default should be the single source of truth for the
  common case.
* Preserve today's behaviour byte-for-byte for existing users (no-op
  upgrade): no setting → `builtin:default` → exact strings that
  `run-thread.ts` ships today.
* Keep the data model simple enough to display and edit in a settings
  panel without inventing a new editor framework.
* Don't add a new SQLite table when the existing key-value
  `app-settings` namespace fits a low-row-count config.

## Considered Options

1. **Sectional harness, global default + per-agent override (this ADR).**
   A `Harness` is a bundle of named sections (`capabilities`,
   `plan_first`, `presentation`, `citation`, `self_config`), each with
   `enabled` + `body`. Built-ins live in code; user-created customs
   live in the `app-settings` KV store. `agent_configs.harness_id`
   (nullable) overrides the global default per agent.
2. **Single text blob per harness.**
   One editable text block replaces the five constants entirely.
   Simpler model and UI, but users can't keep most defaults and
   override one section — every custom harness becomes a fork of the
   whole scaffolding.
3. **Per-section toggles only, no presets.**
   Just expose the five sections as boolean toggles + textareas in the
   global settings. No notion of named bundles. Cheap to ship but
   collapses "I want the strict-citations agent" into "remember which
   five toggles you flipped last time" — no shareable presets, no
   per-agent variation without coupling to global state.
4. **Two-level override (global → per-agent textarea overrides).**
   Per-agent editor exposes the sections directly with optional
   overrides on top of the global default. Maximum flexibility but
   doubles the surface area users need to reason about.

## Decision Outcome

Chosen option: **1**, because:

* Sectional structure mirrors how the harness is already conceptually
  organised in `run-thread.ts` (five named constants). Promoting that
  structure into the data model is a faithful encoding rather than a
  redesign.
* Named bundles ("Default", future "Strict", "Conversational") are the
  unit users naturally talk about. Selecting a bundle per agent is a
  one-click decision; tuning toggles per agent is not.
* Built-ins as read-only code + customs as KV entries keeps the
  storage trivial. No new table, no migration beyond a single nullable
  column on `agent_configs`.
* Agent-level override is a single `harness_id` field. No textarea
  overrides at the agent level — if a user needs a tweak, they clone
  Default into a custom harness and point the agent at it. One layer
  of indirection, not two.

## Decision details

### Data model

```ts
// lib/agents/harness/types.ts
export const HARNESS_SECTION_KEYS = [
  "capabilities",
  "plan_first",
  "presentation",
  "citation",
  "self_config",
] as const;
export type HarnessSectionKey = typeof HARNESS_SECTION_KEYS[number];

export interface HarnessSection {
  enabled: boolean;
  body: string;
}

export interface Harness {
  id: string;            // "builtin:default" | "custom:<uuid>"
  name: string;
  description?: string;
  builtin: boolean;      // true = read-only
  sections: Record<HarnessSectionKey, HarnessSection>;
}
```

### Storage

* **Built-ins** live in `lib/agents/harness/presets.ts`. The `*_CTX`
  strings move out of `run-thread.ts` and become section bodies of
  `builtin:default`.
* **Customs** + **default selection** live in the existing
  `memory_store` table under namespace `app-settings`, keys
  `harnesses` (JSON array) and `default_harness_id` (JSON string).
  Mirrors how `embedding_model_config` is already stored
  ([lib/stores/app-settings.ts](../../lib/stores/app-settings.ts)).
* **Per-agent override:** additive
  `ALTER TABLE agent_configs ADD COLUMN harness_id TEXT;` — `NULL`
  means "use global default".

### Resolution

```
resolveHarness(agentCfg) =
  effective_id = agentCfg.harness_id
              ?? appSettings.default_harness_id
              ?? "builtin:default"
  harness = lookup(builtins) ?? lookup(customs) ?? builtin:default
  return { [key]: section.enabled ? section.body : "" for key in HARNESS_SECTION_KEYS }
```

Stale `harness_id` (custom deleted out from under an agent) falls back
to `builtin:default` rather than erroring — this matches how missing
model configs behave today.

### Wiring

`run-thread.ts` calls `resolveHarness(agentCfg)` once per turn and
injects the five strings into `systemParts` in the same positions the
constants occupy today. Disabled sections produce empty strings and
drop out via the existing `.filter(Boolean)`.

### API

* `GET /api/v1/harnesses` — list all + default id.
* `POST /api/v1/harnesses` — create custom.
* `PATCH /api/v1/harnesses/[id]` — update custom (404 on built-ins).
* `DELETE /api/v1/harnesses/[id]` — delete custom (nulls referencing
  agents' `harness_id`).
* `PUT /api/v1/harnesses/default` — set global default.

Bodies validated with `zod` per repo convention.

### UI

* New "Harness" panel under the **Advanced** tabs in
  [components/layout/MenuPanel.tsx](../../components/layout/MenuPanel.tsx).
  Lists all harnesses, lets user pick the global default, clone
  built-ins, edit/delete customs.
* New row in the AgentEditor "Advanced settings" step
  ([components/agents/AgentEditor.tsx](../../components/agents/AgentEditor.tsx)):
  a `<select>` choosing between "Use global default (<resolved name>)"
  and any specific harness.

## Consequences

* Good — the behavioural contract that today is hidden in module
  constants is now explicit, editable, and discoverable. Users who
  want a strict research agent can build one without forking source.
* Good — no-op upgrade. With no settings touched, `resolveHarness`
  returns `builtin:default`, whose section bodies are the verbatim
  current strings.
* Good — sectional model lets users keep four sections at default and
  rewrite only one (typical case), without forking the whole prompt.
* Bad — adds one nullable column to `agent_configs` and a small
  amount of new persisted state (the customs list + default-id key).
  Acceptable: KV namespace already exists; the column is additive.
* Bad — built-ins drift if we change the strings in code: the
  custom-harness textareas users edited won't auto-update. Mitigated
  by a "Reset to built-in default" button per section in the editor.
* Neutral — the harness can be made empty (all sections disabled),
  which is a self-inflicted footgun. We don't guard against it: the
  identity/instructions textareas are still there, and a power user
  who wants minimal scaffolding has a legitimate use for it.

## Out of scope

* Shipping additional built-in presets beyond `Default` in this PR.
  Structure first, presets later — additive once the framework lands.
* Per-section overrides at the agent level (option 4 above). If demand
  surfaces, the model already supports it; only the UI grows.
* Versioning / history for harness edits. The KV namespace can hold a
  history list later if needed; for now, "last write wins".
* Sharing / import / export of harnesses across instances. The JSON
  shape is stable enough that copy-paste works today.

## More Information

* Affected runtime path: [lib/agents/run-thread.ts](../../lib/agents/run-thread.ts)
  `prepareThreadRun` → `systemParts` assembly.
* Related: [ADR-0010](0010-agent-led-setup-and-integration-manifests.md)
  (the `propose_config_change` flow described in the `self_config`
  section). Toggling that section off disables agents from proposing
  config changes — intentional behaviour, not a bug.
