---
status: "accepted"
date: 2026-05-26
deciders: example-user
---

# ADR-0027: Event-driven watchers (periodic tool poll + diff)

## Context and Problem Statement

Scheduled tasks (ADR-0022, ADR-0025 `scheduled_task` handler) fire the
agent on a cron — the agent runs every time the cron matches, regardless
of whether the world changed. For many user asks ("tell me when ABC-123
moves to In Review", "let me know if my inbox has anything new", "poke
me when this Confluence page version bumps") that's wasteful: an LLM
call per cron tick to read a value and decide that nothing changed.

We want a sibling trigger kind that:

1. Polls one built-in tool at a fixed interval.
2. Hashes the tool's result and only invokes the agent when the result
   *differs* from the previous poll.
3. Hands the agent both the previous and current value as context, so
   the firing prompt is "summarise what changed and decide whether the
   user needs to know".

## Decision Drivers

* Same pattern as scheduled tasks (`schedule_task` ↔ `schedule_watcher`,
  `list_scheduled_tasks` ↔ `list_watchers`, `cancel_scheduled_task` ↔
  `cancel_watcher`) so agents and users carry one mental model.
* Zero LLM tokens between changes — only the polled tool runs each tick.
* Plug into the existing `TriggerHandler` abstraction (ADR-0025) without
  rewriting the scheduler or the runner.
* Single-process invariant (ADR-0011): no new daemon, no separate
  worker — the existing 30 s scheduler tick drives polling.

## Considered Options

1. **A. Agent-prompted polling.** Cron + a prompt like "call X, compare
   to last reply, surface if different". The agent does the diff.
2. **B. Handler-driven polling (this ADR).** A `watcher` trigger handler
   invokes the tool directly, hashes the result, and only produces a
   `TriggerFiring` when the fingerprint changes.
3. **C. Per-tool watcher kinds.** A dedicated `jira_watcher`,
   `confluence_watcher`, `inbox_watcher`, etc.

## Decision Outcome

Chosen option: **B**, because it's the only option that delivers
zero-token idle polling and keeps the trigger abstraction generic.
Option A burns a full LLM round-trip every tick even when nothing
changed; option C duplicates the same poll+diff logic per tool surface
and grows the surface unboundedly.

### Schema (`watchers` table)

```
id, agent_id, label,
tool_name, tool_args (JSON),
interval_seconds,
last_fingerprint (sha256 of last stringified result),
last_result (raw stringified result, fed back as "previous" in firing),
last_run_at, last_fired_at, last_error,
next_run_at, enabled (0|1), silent (0|1),
created_at, updated_at
```

Indexed on `(enabled, next_run_at)` to match the scheduled-tasks due-row
query shape.

### Polling loop

`watcherHandler.getDueFirings(asOf)` is the single owner of polling state:

1. `SELECT * FROM watchers WHERE enabled=1 AND next_run_at <= asOf`.
2. For each due row, look up the tool in the built-in registry,
   `tool.invoke(JSON.parse(tool_args))`. Stringify the result.
3. Compute `sha256(result)`. Compare to `last_fingerprint`.
4. Always update `last_run_at`, `last_result`, `last_fingerprint`, and
   advance `next_run_at` by `interval_seconds`.
5. Emit a `TriggerFiring` only when the fingerprint changed *and* this
   wasn't the first observation (so the first poll seeds the baseline
   without firing).
6. Tool errors are recorded on `last_error` and surfaced in the UI; the
   watcher stays enabled (transient failures shouldn't disarm long-lived
   watchers).

`markFired` then only publishes the `task_completed` notification —
scheduling bookkeeping is finished inside `getDueFirings` because that's
the one place we know about both fired and unfired polls.

### Firing prompt

```
Watcher "<label>" detected a change.

Tool: <tool_name>
Args: <pretty JSON>

--- Previous result ---
<stringified last_result, or "(none — first observation)">

--- Current result ---
<stringified current result>

Summarise what changed and decide whether the user needs to know. If
nothing material changed, you may stay silent.
```

The `silent` flag re-uses ADR-0022's NO_REPLY contract so the agent can
suppress immaterial diffs. Firings are tagged `category=watcher` so the
chat-panel filter toolbar can group/hide them.

### Trust model

* **Built-in tools only.** Watchers refuse to schedule MCP / external
  tools — the scheduler has no per-request context, so any tool that
  needs a thread/agent context can't be polled safely.
* **Interval floor of 60 s.** A runaway watcher otherwise hammers
  providers; enforced in both the store (`clampInterval`) and the zod
  schemas on the HTTP + tool surfaces.
* **No automatic firing on first observation.** Otherwise creating a
  watcher would always fire once with `previous = (none)`, which is
  noisy.

### Agent surface

Three tools registered under `"Schedule"`:

* `schedule_watcher({ label, tool, args?, every_seconds, silent? })` →
  `{id, next_run_at, interval_seconds, silent}`.
* `list_watchers()` → `{watchers, count}` scoped to the current agent
  via the thread's `agent_id`.
* `cancel_watcher({id})` → `{ok, id}`.

### HTTP surface

* `GET /api/v1/watchers?agent_id=…` → list.
* `POST /api/v1/watchers` → create (validates tool exists locally).
* `PATCH /api/v1/watchers/[id]` → label / interval / enabled / silent.
* `DELETE /api/v1/watchers/[id]` → cancel.
* `POST /api/v1/watchers/[id]/run` → force a poll now; fires the agent
  only when the result differs from `last_fingerprint`.

### UI

The existing **Scheduled Tasks** panel grows an **Event-driven Tasks**
section underneath, with the same card layout (label / tool / interval
+ overdue badge / last poll / last fire / error / pause / poll-now /
cancel). The empty state directs the user back to the agent
(`schedule_watcher`).

## Consequences

* Good — agents now have a low-cost way to keep tabs on slow-moving
  external state.
* Good — extends the trigger abstraction without changing it (third
  registered handler, same `runTriggerTick` loop).
* Good — diff context is given to the agent verbatim, so the agent
  decides materiality (vs. trying to encode "what counts as a change"
  in the watcher itself).
* Bad — polling state bookkeeping happens inside `getDueFirings`, which
  is a small abstraction leak compared to scheduled-tasks (where
  `markFired` advances `next_run_at`). Necessary because watchers must
  bump scheduling even for unfired polls. Documented in the handler.
* Bad — only built-in tools are watchable. MCP-only tools (e.g. a
  specific MCP-provided Jira surface) can't be polled until we have a
  context-free invocation path for MCP. Deferred.
* Bad — diff is "fingerprint equality, full bodies as context". For
  very large results (e.g. a 10k-line CSV) every changed character
  copies both versions into the firing prompt. Acceptable v1: agents
  watching such large surfaces should narrow with `args`.

## Out of scope

* Structural diffs (e.g. JSON patch) in the firing prompt — agents
  handle this fine on small/medium results.
* Inter-watcher dedup ("two watchers on the same tool+args").
* fs_watch / file-system event triggers (ADR-0025 PR-D).
* Auto-throttling watchers that error repeatedly. Errors surface in the
  UI; the user / agent disables them.
