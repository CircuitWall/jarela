---
status: accepted
date: 2026-05-26
deciders: Andrew Wu
---

# Scripted trigger firings

## Context and Problem Statement

[ADR-0025](0025-trigger-abstraction-and-change-tracker.md) introduced
the trigger abstraction (`TriggerFiring`, `TriggerHandler`) so the
scheduled-task cron loop and the planned `tool_call` / `fs_watch`
trigger kinds could share one runner, one silent-mode wrapper, one
notification path.

That abstraction assumed every firing **opens a thread and runs an
agent prompt.** It works for "summarise the new PRs" and "tell me what
changed in the doc" but not for two pipelines we now need to land:

1. **Per-file re-indexing** ([ADR-0024](0024-document-rag.md), PR-D).
   `fs.watch` fires on a save → we want to chunk + embed *just that
   file* into `document_chunks`. There's no agent reply, no thread,
   no assistant turn — just a database side effect.
2. **Fast remote sweep** ([ADR-0026](0026-remote-document-sources.md)
   follow-up). Confluence / Jira sources need a 60 s poll cadence
   (vs. the existing 10-min full sweep) to feel "live". Same shape:
   no thread, no LLM, just `runRemoteSource(source)`.

A naive implementation would build a parallel non-trigger code path
("just call the indexer in a setInterval"). That gives up everything
the trigger abstraction earns: idempotent boot, a single fan-out
loop, uniform error handling, lifecycle-managed shutdown, and
testability without a real timer.

## Decision

Generalise `TriggerFiring` into a **`mode: "prompt" | "script"`
discriminated union.**

```ts
interface TriggerFiringBase { id; kind; meta?; }
interface PromptFiring extends TriggerFiringBase {
  mode: "prompt"; agentId; prompt; silent?; category?;
}
interface ScriptFiring extends TriggerFiringBase {
  mode: "script"; script: string; args?: Record<string, unknown>;
}
type TriggerFiring = PromptFiring | ScriptFiring;
```

Add an in-process **script registry** (`lib/triggers/scripts.ts`) —
a `Map<string, (args) => Promise<{preview}>>` keyed by short
identifiers like `documents.reindex_local_file` and
`documents.run_remote_source`. The runner gains a sibling
`runTriggerScript(firing)` that looks up the script and invokes it,
mirroring `runTriggerAgent`'s outcome shape. A new top-level
`runTriggerFiring(firing)` routes by `firing.mode`.

Two new built-in handlers ride the abstraction:

- **`fs_watch`** — owns one `fs.watch(rootPath, { recursive: true })`
  per enabled `local_folder` source, debounces events for 500 ms per
  `(source_id, abs)`, and emits `ScriptFiring`s for
  `documents.reindex_local_file`.
- **`doc_fast_sweep`** — throttled to once-per-source per 60 s
  (env-tunable via `JARELA_FAST_REMOTE_SWEEP_MS`), emits
  `ScriptFiring`s for `documents.run_remote_source`.

Both handlers gain optional `start()` / `stop()` / `sync()` lifecycle
hooks on `TriggerHandler`. `start` is called from
`instrumentation.ts`; `stop` from `lib/lifecycle/shutdown.ts`; `sync`
is fired by the document-source mutation routes so add/edit/delete
re-evaluates the watcher set without a process restart.

## Trust model

The script registry is **built-ins only.** Scripts are registered in
TypeScript at module load time. There is no DB row, no config file,
no shell-out, no `eval`, no plugin path. `firing.script` is just a
key into a fixed map; an unknown key returns
`{status: "error", error: "Script ... not registered"}` and the
firing is dropped.

This keeps script firings safe even though they bypass the LLM/thread
gating that prompt firings have. User-defined scripts are explicitly
out of scope for this ADR — they need a separate threat model
(allowlists, sandboxing, capability tokens) and are best deferred
until there's a concrete user need.

## Scope

In:

- `TriggerFiring` discriminated union and the runner / fan-out
  changes that come with it.
- Script registry + `documents.reindex_local_file` and
  `documents.run_remote_source` built-ins.
- `fs_watch` + `doc_fast_sweep` handlers and their lifecycle wiring.
- Notify hook on document-source mutations.

Out (deferred):

- Scheduled-task UI / schema changes. `scheduled_tasks` rows still
  carry `prompt`/`agent_id` only; the editor doesn't expose a
  "script" mode. A follow-up ADR + PR opens the schedule editor to a
  user-pickable script after we have at least one user-relevant
  built-in beyond the document pipeline.
- Migrating the existing 10-min full sweep onto `change_tracker`
  (ADR-0025 PR-D). The fast sweep is additive; the full sweep stays
  as a safety net for upstream deletions and missed events.
- An Atlassian webhook receiver. Public-endpoint exposure has its own
  threat model.

## Consequences

- The trigger abstraction now earns its keep — three concrete
  consumers (scheduled-task, fs-watch, fast-sweep) means it satisfies
  the "abstract on demand, not pre-emptively" rule from CLAUDE.md.
- The cron path is unchanged in behaviour: the scheduled-task handler
  emits `mode: "prompt"` firings and goes through the same
  `runTriggerAgent` it always did.
- One mutex, one telemetry path, one error-handling story for both
  agent and script firings.
- Future trigger kinds (tool_call from ADR-0025 PR-C, MQTT, S3
  events, webhook receivers) all plug into the same shape; if any of
  them want a non-chat side effect they can register a script.
- TypeScript's discriminated union forces every consumer of
  `TriggerFiring` to narrow on `mode` before reaching `agentId` /
  `prompt` — surface area for "I forgot this is now optional" bugs is
  the type-checker's problem, not a runtime one.

## Related

- [ADR-0024](0024-document-rag.md) — document RAG (PR-D was the
  motivation here).
- [ADR-0025](0025-trigger-abstraction-and-change-tracker.md) — the
  base trigger abstraction this extends.
- [ADR-0026](0026-remote-document-sources.md) — remote document
  sources (the consumers of the fast sweep).
