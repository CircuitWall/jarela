---
status: "accepted"
date: 2026-05-27
deciders: example-user
---

# ADR-0031: Script-backed watcher reactions

## Context and Problem Statement

ADR-0027 wired event-driven watchers; ADR-0030 let the user override the
firing prompt with a per-watcher directive. Both still react via an LLM
turn — every change triggers an agent run. For a class of reactions
that are mechanical (post a notification, append a row to a log,
publish to memory) the LLM round-trip is wasted: the user already knows
what they want done; they just need it to happen on change.

The trigger framework already has the right primitive: `ScriptFiring`
(ADR-0028) runs an in-process function with no thread / LLM /
persisted-message overhead. fs-watch uses it to call
`documents.reindex_local_file`. We want user watchers to be able to
choose `script` as the reaction mode, paying zero LLM tokens per fire.

## Decision Drivers

* Reuse the existing `ScriptFiring` runner — no new firing mode, no new
  trigger plumbing.
* Reaction kind is one of two well-known values; not a free-form
  extensibility point. Keeps the schema and validation tight.
* Built-in scripts only (same trust model as ADR-0027 watchers and
  ADR-0028 scripts). No eval, no shell, no user-defined code.
* Existing watchers with `reaction_kind = 'agent_prompt'` keep working
  unchanged.
* Script names are namespaced (`reaction.*`) so internal scripts like
  `documents.reindex_local_file` aren't accidentally exposed as user
  reactions.

## Considered Options

1. **A. Two columns + tagged union (this ADR).**
   Add `reaction_kind`, `reaction_script`, `reaction_script_args`
   alongside the existing `reaction_prompt`. The watcher handler reads
   `reaction_kind` and emits a `PromptFiring` or `ScriptFiring`
   accordingly.
2. **B. Single TEXT column holding a JSON blob.**
   E.g. `reaction = '{"kind":"agent_prompt","prompt":"…"}'`. Smaller
   schema footprint, but every read/write parses JSON, every
   indexed/queryable surface (e.g. UI filtering by reaction kind)
   becomes substring matching, and validation moves to runtime.
3. **C. Separate `watcher_reactions` table joined by watcher_id.**
   Fully normalised. One row per kind. Overkill for two stable kinds
   that change one-at-a-time.
4. **D. Stretch the existing `reaction_prompt` to dual-purpose.**
   Sentinel-prefixed: `script:reaction.notify {...}` for scripts,
   plain text for prompts. Saves a column but is exactly the kind of
   "magic string parsing" we work to avoid.

## Decision Outcome

Chosen option: **A**, because it gives every kind its own typed column,
keeps the discriminator (`reaction_kind`) directly queryable, and
validates at the schema layer. The runtime cost — three nullable TEXT
columns — is negligible compared to keeping the watcher row
self-describing.

Option B trades schema typing for a parse-on-every-read penalty and is
a known anti-pattern in this codebase (cf. how `tool_args` is JSON for
necessary reasons but `reaction_kind` doesn't need to be). Option C is
defensible long term but premature for two kinds. Option D is a
parsing footgun.

### Schema (additive)

```
reaction_kind          TEXT NOT NULL DEFAULT 'agent_prompt',
reaction_script        TEXT,           -- only when kind='script'
reaction_script_args   TEXT,           -- JSON object; only when kind='script'
reaction_prompt        TEXT,           -- only when kind='agent_prompt' (ADR-0030)
```

`reaction_kind` is constrained at the application layer to
`'agent_prompt' | 'script'`. We do not add a SQL `CHECK` constraint —
SQLite migrations that introduce checks against existing rows are a
pain we don't need; the zod / store layers enforce it.

Existing rows have `reaction_kind = 'agent_prompt'` (the column
default), `reaction_script = NULL`, `reaction_script_args = NULL`, and
unchanged behaviour.

### Reaction-script registry

`reaction.*` is the namespace prefix for scripts users can attach to
watchers. `lib/triggers/scripts.ts` keeps one registry; a new
`listReactionScripts()` filters to that prefix. The watcher
schedule/update paths reject script names that don't begin with
`reaction.` so internal scripts (`documents.reindex_local_file`) can't
be selected by accident.

Built-in scripts shipped in v1:

* **`reaction.notify`** — publish a `task_completed` notification with
  the watcher's label and a short preview of the diff. Optional args:
  `{ title?: string, level?: "info" | "warning" }`. Title defaults to
  the watcher label.

More reaction scripts (`reaction.append_log`,
`reaction.write_memory`, `reaction.webhook`) are intentionally
deferred to follow-up work — webhook in particular is a separate ADR
because of secret handling.

### Watcher handler emits the right firing kind

`pollDueWatchers` in `lib/triggers/handlers/watcher.ts` branches on
`watcher.reaction_kind`:

* `'agent_prompt'` (default) — emit `PromptFiring` exactly as today.
* `'script'` — emit `ScriptFiring` with
  ```
  {
    mode: "script",
    script: watcher.reaction_script,
    args: { ...userScriptArgs, watcher: {id,label,tool_name,tool_args,agent_id}, previous, current },
    meta: { label, tool_name, kind: 'reaction_script', agent_id },
  }
  ```

`watcher.markFired` is extended to publish a `task_completed`
notification for script firings too (today it early-returns for
script mode), with `thread_id = ""` and `prompt` set to a short
"Watcher '<label>' fired script <script>" line.

### Agent surface

`schedule_watcher` accepts a `reaction` discriminated object:

```ts
schedule_watcher({
  label, tool, args?, every_seconds, silent?,
  reaction?: 
    | { kind: 'agent_prompt', prompt?: string }      // ADR-0030
    | { kind: 'script', script: string, args?: object },
});
```

For backwards compatibility we also accept the flat `reaction_prompt`
field added in ADR-0030 — passing it is equivalent to
`reaction: { kind: 'agent_prompt', prompt: ... }`. Setting both is an
error.

A new tool `list_reaction_scripts()` returns the set of registered
reaction scripts so the agent can pick one. (Distinct from
`list_scripts` which we don't expose — internal scripts aren't a user
surface.)

### HTTP surface

`POST /api/v1/watchers` and `PATCH /api/v1/watchers/[id]` accept the
same `reaction` discriminated object and the legacy flat
`reaction_prompt`. `GET` returns the columns separately
(`reaction_kind`, `reaction_prompt`, `reaction_script`,
`reaction_script_args`) so the UI can render the right editor.

### UI

The watcher card's existing "Reaction" row becomes a small
segmented-control toggle (`Agent prompt` / `Script`). Switching
reveals the matching editor (textarea for prompt; script picker +
JSON args field for script). Switching modes does not destroy the
other field's value until the user saves.

## Consequences

* Good — script reactions consume zero LLM tokens. A "ping me on
  change" watcher costs one tool poll per interval and one
  notification publish per fire.
* Good — reuses `ScriptFiring` end-to-end; no new firing mode, no
  runner change, no notification schema change.
* Good — kinds are typed columns, not blob fields. Future SQL queries
  ("find watchers using reaction.notify") are trivial.
* Bad — three nullable columns instead of one polymorphic blob. We
  accept the spread for clarity.
* Bad — agent surface gains a discriminated union (`reaction:
  {kind:..., ...}`), which is more shape than the simple
  `reaction_prompt` of ADR-0030. The legacy flat field stays accepted
  to avoid breaking any agent prompt that already calls
  `schedule_watcher` with `reaction_prompt`.
* Bad — only one reaction script ships in v1. Acceptable: the
  abstraction proves out, and adding more scripts is one file each.

## Out of scope

* Webhook / HTTP-callout reactions (separate ADR; needs secret
  handling and host allow-listing).
* User-defined / shell-out / eval scripts. Hard no.
* Per-firing override of the reaction kind (one watcher = one
  reaction).
* Scripts that talk back to the agent. If a script wants to engage an
  agent, the user should use `kind: 'agent_prompt'`.

## More Information

* Builds on [ADR-0027](0027-event-driven-watchers.md) (watcher schema
  and polling loop), [ADR-0028](0028-scripted-trigger-firings.md)
  (`ScriptFiring` and the script registry), and
  [ADR-0030](0030-user-defined-watcher-reaction-prompt.md) (user-supplied
  reaction directive).
