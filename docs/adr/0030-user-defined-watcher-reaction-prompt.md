---
status: "accepted"
date: 2026-05-27
deciders: andwu
---

# ADR-0030: User-defined reaction prompt on watchers

## Context and Problem Statement

ADR-0027 wired event-driven watchers: a tool is polled on an interval,
the result is hashed, and on a fingerprint change the agent fires with a
hardcoded directive — "Summarise what changed and decide whether the
user needs to know." That directive lives in
`buildFiringPrompt` in [lib/triggers/handlers/watcher.ts](../../lib/triggers/handlers/watcher.ts)
and is identical for every watcher.

In practice users want the *reaction*, not just the detection, to be
configurable: "alert me only if the price drops more than 5%", "open a
Jira ticket against the broken dashboard", "DM me the diff in
plain English". Today the only way to get that behaviour is to bake the
instruction into the agent's system prompt, which leaks per-watcher
intent into the agent definition and prevents one agent from carrying
multiple watchers with distinct reactions.

How should a watcher carry the *instruction* the agent runs against the
diff?

## Decision Drivers

* Same data model as scheduled tasks where possible — keep
  watcher/scheduled-task parity (see ADR-0027 driver list).
* Additive schema change — existing rows must keep working without
  migration data-fill.
* Zero behaviour change for watchers that don't opt in (the default
  "summarise the diff" template stays).
* No new code paths in the runner — the firing remains a `PromptFiring`;
  only the prompt body is parameterised.
* Stay inside the single-process invariant (ADR-0011).

## Considered Options

1. **A. Per-watcher `reaction_prompt` column** (this ADR). Nullable
   `TEXT` field on `watchers`. When non-null, `buildFiringPrompt`
   substitutes it for the hardcoded directive; previous + current
   results are still appended as `--- Previous ---` / `--- Current ---`
   blocks so the agent always has the diff context.
2. **B. Prompt-template DSL with placeholders.** Same column, but the
   user writes a full template (`"Watcher {label} fired. Diff: {diff}.
   Action: notify Slack."`) and the handler does string substitution
   for `{label}`, `{previous}`, `{current}`, `{tool_name}`, `{args}`.
3. **C. Reaction kinds beyond a prompt.** Generalise the reaction to a
   tagged union: `{kind: "agent_prompt", text} | {kind: "script", name,
   args} | {kind: "webhook", url}`. Lets a watcher react by running a
   script (no LLM) or hitting an HTTP endpoint.
4. **D. Inline the instruction into `label`.** Reuse the existing
   `label` column. No schema change; the agent reads the label.

## Decision Outcome

Chosen option: **A**, because it solves the actual user problem
(per-watcher instruction) with the smallest surface change and stays
fully backwards compatible. The directive is the only piece of the
firing prompt today that varies between user intents; everything else
(`label`, tool name, args, prev/current bodies) is already
data-derived.

Option B is rejected for v1: a templating language is a feature with
its own semantics (escape rules, missing placeholder behaviour, partial
fills) and the agent already reads the surrounding `Watcher "<label>"
detected a change. Tool: ... Args: ... --- Previous --- ...` envelope,
so users get the same context without authoring placeholders. We can
layer placeholders on top later if a real user need shows up.

Option C is the right long-term shape — script- and webhook-backed
reactions are a known follow-up — but it crosses a much larger ADR
(new firing modes on watchers, tool-vs-script registration, secret
handling for webhooks). Folding it into this change would block the
small win on a much bigger decision. Tracked as a follow-up ADR.

Option D is rejected because `label` is what the user *names* the
watcher in the UI list ("Jira ABC-123"). Overloading it as a directive
(>200 chars of instructions) breaks the list view and conflates two
purposes.

### Schema change

Add one column to the `watchers` table:

```
reaction_prompt TEXT NULL
```

Migration: pure additive `ALTER TABLE watchers ADD COLUMN
reaction_prompt TEXT`. Existing rows read as `NULL` and behave exactly
as today. `lib/db/migrations.ts` gets a new migration step; no
data-fill required.

Indexed: no — the column is never queried, only read alongside the
already-fetched row.

### `buildFiringPrompt` change

The current envelope is preserved. Only the closing directive is
swapped:

```
Watcher "<label>" detected a change.

Tool: <tool_name>
Args: <pretty JSON>

--- Previous result ---
<...>

--- Current result ---
<...>

<reaction_prompt if non-null, else default directive>
```

Default directive (unchanged): *"Summarise what changed and decide
whether the user needs to know. If nothing material changed, you may
stay silent."*

The `silent` flag (ADR-0022 NO_REPLY) keeps working regardless of the
reaction_prompt — silencing is orthogonal to the directive content.

### Agent surface

`schedule_watcher` grows one optional parameter, validated by zod:

```
schedule_watcher({
  label, tool, args?, every_seconds, silent?,
  reaction_prompt?,         // NEW. <= 4000 chars. Null/empty → default directive.
})
```

Length cap (4000 chars) prevents a runaway prompt blowing up the
firing token count; enforced in the store and zod schema. `list_watchers`
returns the field so an agent can introspect.

### HTTP surface

`POST /api/v1/watchers` and `PATCH /api/v1/watchers/[id]` both accept
`reaction_prompt`. `PATCH` treats `null` and `""` as "clear back to
default". The existing zod schemas under [api/](../../api/) gain the
optional field.

### UI

The watcher card in the **Event-driven Tasks** section grows a
collapsible **"Reaction prompt"** field. Empty / collapsed = default
behaviour. The field is plain text; no markdown, no template syntax.

## Consequences

* Good — per-watcher reactions without per-watcher agents. One agent
  can host many watchers with distinct intents.
* Good — fully additive: every existing watcher keeps its current
  behaviour, no migration backfill, no UI churn for users who don't
  opt in.
* Good — keeps scheduled-task / watcher parity (`label`,
  `interval_seconds`, `silent` are still the only behaviour knobs;
  `reaction_prompt` is the watcher-specific addition that has no
  scheduled-task analogue *yet*).
* Bad — the same prompt fires every time the watcher detects a change.
  No per-firing variability beyond the diff context. Acceptable: the
  agent has the full prev/current bodies and the user's intent; that's
  enough for it to vary its response.
* Bad — agent-authored prompts can drift from the watcher's
  detection. A user might write a `reaction_prompt` that asks for data
  the diff doesn't contain. Mitigation: the envelope still ships the
  diff; the agent decides what to use.
* Bad — defers the larger script-/webhook-reaction question (option
  C). We accept that and track a follow-up ADR.

## Out of scope

* Script-backed and webhook-backed reactions (deferred — separate
  ADR).
* Placeholder substitution / templating (deferred until a concrete
  user need).
* Per-firing reaction overrides (e.g. "this run only, ask me X
  instead").
* Reaction prompt for scheduled tasks (ADR-0022 already accepts a
  free-form prompt at schedule time; not symmetrical with watchers,
  intentionally).

## More Information

* Builds on [ADR-0027](0027-event-driven-watchers.md) (watcher schema,
  firing prompt, polling loop).
* Foreshadows a follow-up ADR for non-prompt reactions (script /
  webhook), referenced in option C above.
