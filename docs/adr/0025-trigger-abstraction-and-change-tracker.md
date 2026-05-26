---
status: accepted
date: 2026-05-26
deciders: Andrew Wu
---

# Trigger abstraction and change-tracker primitive

## Context and Problem Statement

Jarela's only autonomous-firing path until now was the scheduled-task
cron loop: `lib/scheduler/index.ts` polled `scheduled_tasks` every
30 s, then opened a thread, ran the agent, persisted the assistant
turn, and published a `task_completed` notification — all inline.

Three planned features all want to fire the same kind of "open a
thread, run an agent, persist, notify" pipeline, but from different
sources:

1. **Tool-call triggers (PR-C)** — the agent author binds an agent to
   "whenever any agent invokes tool X with arguments matching Y, also
   fire agent A with this prompt". The trigger source is the in-process
   tool-call event, not a clock.
2. **`fs.watch` triggers (PR-D)** — fire an agent on file-system
   change events under a user-configured root, with content-hash
   debouncing so a touch-only modification doesn't fire.
3. **Document indexing (PR-A, already merged on `feat/document-rag`)**
   — already prototypes a diff-and-react loop with mtime+size
   fingerprints in `lib/documents/indexer.ts`.

Without a shared shape, every new trigger source would re-implement
(a) the agent-invocation pipeline, (b) the silent-mode "reply only if
material" wrapping, (c) the assistant-message persistence with the
right category tag, and (d) the notification publishing — and would
risk drifting from the cron path. Worse, the change-detection logic
(was-this-fingerprint-the-same-last-time?) would be re-implemented per
trigger, each storing its own state with its own bugs.

We need:

- A neutral *trigger* shape that the scheduler can iterate over.
- A neutral *change-tracker* primitive that anyone needing
  "did (scope, key) move since I last looked?" can call instead of
  rolling their own.

## Decision Drivers

- Adding the next trigger kind must not require touching the scheduler
  loop.
- The silent-mode contract (NO_REPLY sentinel) and the
  category-filter integration (ADR-0022) are user-visible and must
  not regress.
- The on-disk schema for `scheduled_tasks` must not change — we will
  add abstractions, not migrations.
- Test surface must work without booting the full LLM stack.

## Considered Options

1. Generalize the `scheduled_tasks` table into a `triggers` table with
   a JSON `config` blob and dispatch on `kind`.
2. Keep storage per-kind, introduce a runtime `TriggerHandler`
   interface, and let each handler own its own table.
3. Don't abstract — copy/paste the firing code into each new trigger
   kind.

## Decision Outcome

Chosen option: **2 — handler interface, storage stays per-kind**.

Option 1 looked clean but would force a destructive schema migration
of the live `scheduled_tasks` table for zero new functionality, and
would push kind-specific concerns (cron expression parsing, JID
matching, glob normalisation) into a single `config` blob that the
type system can't help with.

Option 3 is what we had; the duplication cost compounds with every
trigger kind.

### Trigger interface

`lib/triggers/types.ts` defines:

- `TriggerFiring` — `{ id, kind, agentId, prompt, silent?, category?, meta? }`.
  Whatever produced it has already decided the agent should run now;
  the runner does NOT re-check schedule / debounce.
- `TriggerOutcome` — `{ status: "done" | "skipped" | "error", preview,
  threadId, error? }`.
- `TriggerHandler` — `{ kind, getDueFirings(asOf), markFired(firing, outcome) }`.

`lib/triggers/runner.ts` exports `runTriggerAgent(firing)` — the
extracted body of the old `runTask`, owning thread creation, the
silent-mode prompt wrap, NO_REPLY detection, and message persistence
with `userCategory`. The runner deliberately does NOT publish
notifications: different kinds want different payloads, so that lives
in each handler's `markFired`.

`lib/triggers/registry.ts` holds the handler map behind
`getOrCreateGlobal` so HMR and repeated imports don't double-register.

`lib/triggers/index.ts` registers the built-in
`scheduledTaskHandler`, exports `runTriggerTick(asOf)` (the per-tick
fan-out), and exports a `runScheduledTaskFiringNow(taskId)` helper
the existing HTTP "Run now" route consumes via the scheduler's
re-exported `runScheduledTaskNow`.

`lib/scheduler/index.ts` now owns only the timer + the
"is a tick in flight?" mutex; it delegates to `runTriggerTick()`.

### Change-tracker primitive

`lib/stores/change-tracker.ts` backed by a new
`change_tracker(scope, key, fingerprint, updated_at)` table with
`PRIMARY KEY (scope, key)`. Fingerprints are opaque strings — content
hashes, `mtime:size` tuples, etags — and the producer chooses.

API:

- `recordSeen(scope, key, fingerprint) -> { changed, previous }`
  — upserts and reports whether anything moved.
- `getFingerprint(scope, key) -> string | null`
- `hasChanged(scope, key, fingerprint) -> boolean` — non-mutating probe.
- `clearKey`, `clearScope`, `listScope`.

Concurrency: SQLite serialises writes; `recordSeen` is a read of the
current fingerprint followed by an upsert. Two concurrent producers
of the same fingerprint both report `changed=false` after the first
write lands.

This is the same diff-state the document indexer (`lib/documents`)
currently keeps inline in the `documents` table. A future PR will
migrate the indexer onto `change_tracker` once PR-D is in and we have
two consumers of the primitive driving the API shape.

## Consequences

- **Good** — new trigger kinds register a handler, get a tested run
  pipeline + silent mode + categorisation for free.
- **Good** — change detection is now reviewable in one place with one
  test suite, instead of one inline implementation per consumer.
- **Good** — scheduler is now tiny and obviously correct (timer +
  delegate).
- **Neutral** — one extra indirection on every cron tick. Negligible
  at the loop's 30 s cadence.
- **Bad** — until PR-C / PR-D land, the abstraction has one consumer.
  Mitigated by writing the interface against the *next* two
  consumers' known shapes (already prototyped in PR-A's indexer and
  the planned tool-call event surface).

## More Information

- ADR-0022 — per-agent message channel filters (the `scheduled_task`
  category we preserve).
- ADR-0024 — document RAG (the diff-and-react loop that prototypes
  the change-tracker shape).
- Next PRs: PR-C tool-call trigger, PR-D `fs.watch` trigger.
