---
status: "accepted"
date: 2026-05-27
deciders: example-user
---

# ADR-0032: Script-backed scheduled tasks

## Context and Problem Statement

Scheduled tasks (cron-driven triggers) currently always fire by running the
agent with a saved `prompt`. ADR-0031 added a script reaction kind to
**watchers** so that a poll diff can dispatch a registered `reaction.*`
script with no LLM round-trip. The same mechanical-reaction class exists
for time-driven triggers: "every Monday at 9am, ping me with a notification"
or "at 23:59, append a log line" don't need an agent turn — the user already
knows what they want done; they just want it to happen on schedule.

The trigger framework already supports both modes (`PromptFiring` and
`ScriptFiring`, ADR-0028) inside `runTriggerFiring`. The watcher handler
already routes on a `reaction_kind` column. We want the same routing for
scheduled tasks so the cost of a "fire and notify" task is one cron tick +
one notification publish, with no LLM call.

## Decision Drivers

* Reuse the existing `ScriptFiring` runner and `reaction.*` registry — no
  new firing mode, no parallel script namespace, no plumbing fork.
* Keep parity with watchers: same column names (`reaction_kind`,
  `reaction_script`, `reaction_script_args`), same discriminated-union
  rules, so a single shared store helper covers both.
* Existing scheduled tasks with `reaction_kind = 'agent_prompt'` keep
  working unchanged. No data migration.
* Built-in scripts only. Same trust model as ADR-0028 / 0031.

## Considered Options

1. **A. Reuse the watcher schema verbatim (this ADR).**
   Add `reaction_kind`, `reaction_script`, `reaction_script_args` to
   `scheduled_tasks` with the same semantics as ADR-0031. The
   scheduled-task handler branches on `reaction_kind` and emits the
   matching firing.
2. **B. Separate `task_kind` / `task_script` columns + separate `task.*`
   namespace.**
   Cleaner separation of "what runs at fire time" between watchers and
   scheduled tasks, but doubles the registry surface, the listing
   endpoint, and the agent's mental model. Scripts that work for both
   ("publish a notification") would need to be registered twice.
3. **C. New polymorphic JSON `body` column.**
   `body = '{"kind":"agent_prompt","prompt":"..."}'`. Same anti-pattern as
   B in ADR-0031: parse-on-every-read, validation moves to runtime,
   indexed queries become substring matches.

## Decision Outcome

Chosen option: **A**, because:

* It minimises divergence between the two trigger types. The store layer
  can share a single `reaction-shared.ts` helper for validation; the
  handler logic mirrors `pollDueWatchers`; the UI editor is the same
  component.
* The `reaction.*` namespace already exists and is the right home for any
  fire-time mechanical action — diff-driven or schedule-driven. Scripts
  that don't read `previous`/`current` (e.g. `reaction.notify`) work in
  both contexts unchanged.
* Naming is a slight semantic stretch — a scheduled task isn't reacting
  to anything — but the trade-off (one shared vocabulary across both
  trigger types vs. two diverging names for the same concept) clearly
  favours reuse. We accept "reaction" to mean "what fires" rather than
  "what reacts".

### Schema (additive)

```
ALTER TABLE scheduled_tasks ADD COLUMN reaction_kind TEXT NOT NULL DEFAULT 'agent_prompt';
ALTER TABLE scheduled_tasks ADD COLUMN reaction_script TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN reaction_script_args TEXT;
```

`reaction_kind` is constrained at the application layer to
`'agent_prompt' | 'script'` (no SQL `CHECK`, same reasoning as ADR-0031).
Existing rows take the column default. The existing `prompt NOT NULL`
constraint stays — for `kind='script'` we store empty string in `prompt`
and the discriminator decides whether it's read.

### Scheduled-task handler routing

`firingFromTask` becomes `buildFiring`, branching on `reaction_kind`:

* `'agent_prompt'` (default) — `PromptFiring` exactly as today.
* `'script'` — `ScriptFiring` with
  ```
  {
    mode: "script",
    script: task.reaction_script,
    args: { ...userScriptArgs, task: { id, agent_id } },
    meta: { schedule, scheduleKind, reaction_kind: 'script', reaction_script },
  }
  ```

**No `previous` / `current`** — those are watcher concepts. A reaction
script that reads them sees `undefined` for scheduled-task firings; the
existing `reaction.notify` already tolerates this (it normalises with
`?? null` and falls through to a plain "current value" preview).

`markFired` is extended to handle script mode: still call `markTaskRan`
so the schedule advances (or the once-task self-deletes), then publish a
`task_completed` notification with `thread_id = ""` and a short
"Scheduled task fired script <name>" prompt.

### Agent surface

`schedule_task` gains optional `reaction_kind`, `reaction_script`,
`reaction_script_args` fields. `prompt` becomes optional in the schema
when `reaction_kind='script'` — passing both `prompt` and `script` is
not an error (the prompt is simply ignored at fire time per the
discriminated union), but the tool description steers the agent away
from setting both.

The existing `list_reaction_scripts` tool added in ADR-0031 is reused
verbatim — no new tool, single registry surface.

### HTTP surface

`POST /api/v1/scheduled-tasks` accepts the three new optional fields and
makes `prompt` optional (defaults to `""`).
`PATCH /api/v1/scheduled-tasks/[id]` mirrors the watcher PATCH:
`reaction_kind` triggers a full replace of the reaction; without it,
only the matching branch's fields can be patched (kind-preserving
patch).

`GET` returns the four reaction columns separately so the UI can render
the right editor.

The script-listing endpoint stays at `GET /api/v1/watchers/reaction-scripts`
for now. A future cleanup may move it to `/api/v1/triggers/reaction-scripts`,
but it's the same registry — duplicating it for scheduled tasks would
just split the URL surface for no benefit.

### UI

The `ReactionEditor` component is extracted from
`components/scheduled-tasks/WatchersSection.tsx` into a shared
`components/triggers/ReactionEditor.tsx`. It takes a small generic
`ReactionTarget` plus two save callbacks so the watcher panel and the
scheduled-tasks panel can mount the same editor with their own update
endpoints.

The scheduled-tasks card grows a "Reaction" row alongside the existing
prompt row. When `reaction_kind='script'`, the prompt row is hidden (or
rendered disabled) and the script editor takes over.

## Consequences

* Good — script-driven scheduled tasks consume zero LLM tokens. A
  "notify me at 9am every Monday" task costs one cron tick per fire and
  one notification publish, no agent run.
* Good — single shared concept across both trigger types. The user
  learns the reaction kind once.
* Good — the `reaction.*` registry has one home. Scripts that don't
  depend on diff context work for both contexts.
* Bad — "reaction" is a semantic stretch for scheduled tasks. Mitigated
  by the tool description and ADR text making it explicit.
* Bad — duplicates store-layer plumbing across two stores
  (`scheduled-tasks.ts` and `watchers.ts`). Validation helpers are
  extracted into a shared module to keep the duplication shallow.

## Out of scope

* Webhook / HTTP-callout reactions (still deferred from ADR-0030 / 0031).
* User-defined / shell-out / eval scripts. Hard no.
* A unified trigger table that collapses watchers + scheduled tasks into
  one schema. Not blocked by this ADR; both stores keep their primary
  axes (cron schedule vs. tool poll).
* Diff context for scheduled-task scripts. If a future script needs
  per-fire context, it can take it via `reaction_script_args` — there's
  no notion of "previous/current" for a cron tick.

## More Information

* Builds on [ADR-0028](0028-scripted-trigger-firings.md) (`ScriptFiring`
  and the script registry) and [ADR-0031](0031-script-backed-watcher-reactions.md)
  (the `reaction_*` discriminated union for watchers).
