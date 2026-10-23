# ADR-0105: Per-agent usage profiles

Status: Accepted

## Context

The user-profile Persona preset only filtered credential discovery. An agent
used at home needs a different presentation and response style from an agent
used for development, independently of the global Essential/Full navigation.

## Decision

Persist `agent_configs.usage_profile` as `home`, `work`, `dev`, or `custom`
(Everything). Keep the legacy user-profile preset readable for API compatibility,
but remove its editor and stop using it as a live preference.

On the first migration, copy a valid legacy preset to existing agents. If there
is none, use Everything, preserving existing behavior. Do not rewrite tuned MBTI,
citation settings, display filters, tools, or credentials during migration.
New agents default to Everything.

Explicit profile selection in the agent editor applies editable direct style and
citation defaults. Home is warm and summary-first; Work is professional and
decision-oriented; Developer is evidence-first with full diagnostics; Everything
adds no response-style directive. These suggestions are not permissions.

The per-agent Persona editor combines the profile with warmth, expressiveness,
response detail, and conversational-cue adaptation sliders. Remove MBTI from the
editor and runtime behavior; keep its legacy database/API field only for
compatibility. Existing slider values and enable state remain untouched on upgrade,
save, partial update, or duplication. Changing the deprecated MBTI field no longer
applies a preset. Historic MBTI migration code is retained, not re-run.

Resolve profile organization and direct style into one per-turn Persona chapter.
This intentionally moves the short profile instruction from the agent-stable cache
block into the dynamic suffix so it can be composed with turn-specific cue
adjustments. Identity, instructions, and harness sections remain agent-stable;
shared instructions remain identical across agents. Citation coverage stays a
separate chapter and cannot be weakened by style. Strength 0 keeps style steady;
disabling customization keeps profile organization without applying slider targets.

Chat presentation collapses technical diagnostics for Home and Work, with a
session-local reveal control. Failures and approval requests remain visible.
Diagnostics continue to stream and persist; presentation does not filter model
context. Existing channel filters remain independent.

Credential discovery follows the active agent, retains configured integrations,
and offers Show all. Saved credentials are never hidden or revoked. The catalog
has no profile filter when there is no active agent.

## Validation

Verify migration idempotence, CRUD and duplication, API enum rejection, editable
defaults, preserved tuned sliders and MBTI independence, assembled prompt cache
boundaries and single Persona chapter, catalog filtering, and hidden versus
revealed diagnostics with failures still visible. Prompt tests prove instructions
are assembled, not that every model follows them.
