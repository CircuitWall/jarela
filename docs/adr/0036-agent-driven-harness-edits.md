---
status: "accepted"
date: 2026-05-28
deciders: example-user
---

# ADR-0036: Agent-driven harness edits via the approval flow

## Context and Problem Statement

[ADR-0033](0033-configurable-harness.md) made the harness — the behavioural
scaffolding (`capabilities`, `plan_first`, `presentation`, `citation`,
`self_config`) wrapped around every agent turn — a first-class, editable
config object. It deliberately kept editing behind the Settings UI: built-in
presets are read-only code, and custom presets were UI-created only.

Since then, several user requests have framed harness changes as part of
the agent's job ("make this agent stricter about citations", "give this
agent a terser output style"). Routing those through the existing
`propose_config_change` flow is a natural fit: the agent already proposes
edits to MCPs, agent identity/instructions, provider keys, and integrations
through that pipeline, all gated by an explicit user approval banner
([ApprovalsBanner.tsx](../../components/proposals/ApprovalsBanner.tsx)).

This ADR amends ADR-0033 to permit two new capabilities, both behind the
same approval flow:

1. Creating or editing a **custom** harness preset.
2. Switching which harness an agent runs under.

## Decision Drivers

* End-to-end self-configuration: the agent should be able to fulfil
  "tighten the citation rules for this agent" in one conversation, not
  punt to "go open Settings → Harness".
* Built-ins must stay read-only — they're the audited shipped scaffolding,
  not a per-instance preference.
* The global default harness pointer must stay UI-only — flipping it
  affects every agent on the instance, far too high a blast radius for an
  agent-initiated proposal.
* Reuse, don't reinvent: the proposal pipeline (queue → banner approve →
  `applyAction` mutates store) already has the authorization model we need.
* Schema additions must compose with the existing `update_agent` contract
  rather than fragmenting agent-edit into multiple kinds.

## Considered Options

1. **One new kind (`upsert_harness`) + extend `update_agent` with `harness_id`** (this ADR).
   Single new proposal kind for harness mutations; the existing
   `update_agent` kind grows an optional `harness_id` field to do the
   "point this agent at harness X" half. Built-ins rejected at the
   handler boundary; global default pointer not exposed.
2. **Two new kinds: `upsert_harness` + `set_agent_harness`.**
   Cleaner audit trail (the row label reads `set_agent_harness` instead
   of generic `update_agent`), but duplicates handler/UI plumbing — the
   approval banner already groups `update_agent_tools` and `update_agent`
   under one settings-deep-link, and a third sibling adds surface area
   without behaviour the user can perceive.
3. **One new kind (`upsert_harness`) only — assignment stays in UI.**
   Smallest diff, but half-finished: agent creates a harness it can't
   actually point itself at. Forces the user to do the assignment by
   hand, defeating the "self-configure end-to-end" driver.
4. **Reverse ADR-0033 entirely — make the whole harness fully
   agent-mutable, including built-ins and the global default.**
   Maximises agent agency but loses the read-only-built-in property
   ADR-0033 chose deliberately, and risks an agent flipping global
   behaviour for every other agent on the instance.

## Decision Outcome

Chosen option: **1**, because:

* It keeps the schema growth proportional to the new behaviour (one new
  kind, one new optional field), and reuses the existing approval banner,
  toast deep-link pattern (`?tab=harness&item=…`), and `plainApprove`
  path with no new modals.
* It preserves the two ADR-0033 invariants that matter: built-ins stay
  read-only (enforced in `applyUpsertHarness` by rejecting any id
  starting with `builtin:`), and the global default pointer is *not* a
  proposal kind (it remains a Settings-UI-only operation).
* It composes with the prior agent-led-setup precedent
  ([ADR-0010](0010-agent-led-setup-and-integration-manifests.md)): the
  agent proposes, the user approves in-banner, the apply step writes to
  the same store the UI would write to, and the running agent picks up
  changes on its next turn. No new authorization model.

### Consequences

* Good, because end-to-end requests like "give this agent stricter
  citation" are now fulfillable inside one conversation.
* Good, because the audit trail (the `pending_actions` table) captures
  every harness mutation with the agent that proposed it and the
  user-approval timestamp.
* Bad, because the approval banner's payload preview is a JSON dump and
  harness section bodies can be long — readable enough for v1, but a
  custom diff/preview component is a likely follow-up if users complain.
* Bad, because the agent's self-config doc grows another bullet, and
  agents must be guided not to overuse `upsert_harness` for what should
  be `update_agent` identity tweaks. Mitigated by an explicit "use
  sparingly" rule in [SELF_CONFIG_BODY](../../lib/agents/harness/presets.ts).

## Pros and Cons of the Options

### Option 1 — `upsert_harness` + extend `update_agent`

* Good, because reuses one approval row + one toast for the common
  "create harness, then point agent at it" pair.
* Good, because the schema delta is one new kind and one new optional
  field — minimal type-system blast radius.
* Neutral, because two-step UX: the agent typically needs two
  approvals (create harness, then assign it) — but that mirrors how a
  user would do it manually, and the second step is one-click.
* Bad, because `update_agent` now carries a heterogeneous mix of fields
  (identity text, history numbers, harness pointer); not enough to
  fragment, but worth noting.

### Option 2 — Dedicated `set_agent_harness`

* Good, because audit trail self-documents.
* Bad, because duplicates the existing `update_agent` handler, settings
  deep-link, and approval row UI for one extra string field.

### Option 3 — `upsert_harness` only

* Good, because absolute minimum new code.
* Bad, because half-finished: the user still has to open Settings to
  point an agent at the new harness. Fails the driver.

### Option 4 — Full agent control

* Good, because no special-cases.
* Bad, because abandons the read-only-built-in property ADR-0033 chose
  for good reasons (auditability of shipped scaffolding); enables
  instance-wide flips with high blast radius.

## More Information

* Extends: [ADR-0033](0033-configurable-harness.md).
* Precedent: [ADR-0010 — agent-led setup and integration manifests](0010-agent-led-setup-and-integration-manifests.md).
* Implementation:
  * [lib/tools/propose.ts](../../lib/tools/propose.ts) — schema +
    payload doc.
  * [lib/agents/proposals.ts](../../lib/agents/proposals.ts) —
    `applyUpsertHarness` handler + extended `applyUpdateAgent`.
  * [lib/stores/harnesses.ts](../../lib/stores/harnesses.ts) —
    pre-existing `createCustomHarness` / `updateCustomHarness` reused
    verbatim.
  * [components/proposals/ApprovalsBanner.tsx](../../components/proposals/ApprovalsBanner.tsx) —
    toast deep-link case.
* Out of scope: `delete_harness` proposal kind (defer; users delete in
  UI), `set_default_harness` proposal kind (intentionally not exposed —
  global default stays UI-only), custom diff/preview component for the
  approval banner (likely follow-up).
