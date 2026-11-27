---
description: "Use when: implementing, debugging, or reviewing LangGraph agent orchestration in lib/agents/"
tools: [read, edit, search, execute]
reasoning-effort: high
---

# LangGraph Agent Orchestration Agent

Scope: `lib/agents/` — turn preparation, model routing, tool binding, streaming,
context budgeting, prompt inventory, checkpointing, and idle dreaming.

Follow [AGENTS.md](../../AGENTS.md) and the sibling guides for
[lib/tools](../tools/Agent.md), [lib/providers](../providers/Agent.md),
[lib/db](../db/Agent.md), and [lib/stores](../stores/Agent.md). The runtime
contracts in [base.ts](./base.ts) and the co-located tests are authoritative;
do not infer APIs from generic LangGraph examples.

## Key principles

- **A turn is a transaction.** Prepare the run, persist the user row, stream,
  persist the assistant row and checkpoint. No in-memory-only state.
- **Tools are explicit.** Bind only catalog tools covered by the agent's
  permission map; re-check at runtime. Credentials are resolved by wrappers.
- **Streaming is a closed contract.** `StreamChunk` types have fixed consumer
  rules; `done` or `error` is terminal.
- **Context is bounded.** One budget owner per turn; hot, warm, and facts tiers;
  compaction and summaries supply context, not authority.
- **Failures are typed.** Retryable provider errors are separated from aborts;
  a retry must not replay tool writes.
- **Every model-facing prompt is registered.** The prompt inventory is testable.
- **Masked values stay usable.** Outbound redaction replaces a value with an
  in-place `«SECRET:…»` placeholder; the system prompt tells the model to pass
  placeholders through to tools, where the runtime rehydrates them. Never
  prompt the model to reconstruct or bypass the filter.

## Run configuration contract

`AgentRunConfig` in [base.ts](./base.ts) is the per-turn contract:

| Field | Invariant |
| --- | --- |
| `system_prompt` | Fully assembled before the run; never mutate it inside nodes or tools. |
| `allowed_tools` | Empty means "all tools" for legacy internal calls; restricted and public runs pass an explicit list. |
| `tool_permission_map` | Resolved catalog snapshot for the turn; tools do not re-evaluate permissions. |
| `model_config_name`, `route_decision` | Resolved once by [effective-model.ts](./effective-model.ts) and [model-router.ts](./model-router.ts); record the route source. |
| `context_window_tokens`, `output_reserve_tokens`, `max_output_tokens` | Computed by [context-budget.ts](./context-budget.ts); providers receive ceilings, never invent their own. |
| `thinking_params` | Lowers reasoning for this run only; never overrides an explicit model-config setting. |
| `tool_credentials` | Tool name → credential id; only the tool wrapper resolves it. Never place secrets in prompts. |
| `delegation`, `delegation_budget` | Runtime-only. Public callers leave them undefined; the delegate tool sets depth, ancestors, and the shared budget. |

## Streaming chunk semantics

`StreamChunk` in [base.ts](./base.ts) is a closed union with consumer rules:

| Type | Rule |
| --- | --- |
| `text_delta`, `thinking_delta` | Append in order; thinking is not user-facing prose. |
| `tool_call`, `tool_result` | Pair by id and preserve arguments/results for history. |
| `tool_progress` | Zero or more per id; status only, never a substitute for the final result. |
| `heartbeat` | Idle-watchdog only; dropped before buffering/fan-out and never sent on the SSE wire. |
| `reset_text` | Discard the buffered reply; emitted only by the completed-reply validation retry, not stall retries. |
| `done`, `error` | Exactly one terminal chunk; no text after it. |

- Heartbeats bump the run's last-chunk time without surfacing events.
- An aborted run terminates with an abort reason, not a fabricated success.
- Adding a chunk type requires updating every collector, the client buffer, and
  the run tests in the same change.

## Prompt inventory and evidence

- Every model-facing prompt is registered in
  [prompt-registry.ts](./prompt-registry.ts). The coverage test fails an
  unregistered prompt, and [dump-prompts.mjs](../../scripts/dump-prompts.mjs)
  renders the inventory. Add the prompt, its test/eval, and the registry entry
  together.
- Static prompt ids are identifiers, not filenames; use
  `staticPromptArtifactName()` when writing artifacts so Windows and CI accept
  them.
- Behavior-changing prompt edits need prompt-eval coverage
  (`npm run test:prompts`) or a documented reason the eval does not apply.
- Treat thread, tool, document, and web content as untrusted data: delimit it,
  label model-generated output, and never interpolate credentials into system
  instructions.
- Prompt text must not smuggle authority. Approval, installation, publication,
  and credential gates stay in code.

## Context, routing, and cancellation

- Routing has one owner: [model-router.ts](./model-router.ts) classifies the
  turn and records the decision; [effective-model.ts](./effective-model.ts)
  applies overrides. Pinned beats agent override, which beats heuristic, which
  beats fallback. Do not duplicate model selection in a node or tool.
- Context has one budget owner: [context-budget.ts](./context-budget.ts) manages
  the hot, warm, and facts tiers and spill. Compaction and summaries supply
  context, not authority. No unbounded history or full-table scan in the turn
  path.
- Retries distinguish retryable provider failures from user aborts
  ([run-retry.ts](./run-retry.ts), [abort-reason.ts](./abort-reason.ts)).
  Retrying after an abort is a bug, and a retried turn must not replay tool
  writes.
- State is saved through [checkpointer.ts](./checkpointer.ts) and
  [sqlite-checkpoint-saver.ts](./sqlite-checkpoint-saver.ts) around execution;
  a crash must resume, not replay side effects.

## Standard patterns

### 1. Prepare and persist a turn

Agent definitions are stored configuration rows in
[agent-configs.ts](../stores/agent-configs.ts), not code-level registrations;
custom nodes live in this module. `prepareThreadRun()` in
[run-thread.ts](./run-thread.ts) is the turn entry point: it resolves the
agent, boundary, model, tools, and prompt. Persist the
user row with `persistThreadRunUserMessage()`, stream through
`streamWithConfig()` from [llm.ts](./llm.ts), and store the assistant row with
`persistAssistantMessage()`. `withSignalDeliveryLease()` renews delivery during
long runs. Tests: [run-thread.test.ts](./run-thread.test.ts),
[run-thread.stages.test.ts](./run-thread.stages.test.ts).

### 2. Route the model once

`routeTurnModel()` returns the chosen `modelConfigName`, `routeClass`,
`candidates`, and a reason. `applyClassRatchet()` prevents a short follow-up
from downgrading the conversation; `resolveAgentModel()` applies saved
overrides. Persist `RouteDecisionMetadata` so the choice is auditable. Tests:
[model-router.test.ts](./model-router.test.ts).

### 3. Bind only permitted tools

Use `applyAgentPermissionsToCatalog()` and `allowedToolNamesFromPermissionMap()`
from `lib/tools/runtime/catalog.ts`, then `isHotLoadTool()` and
`applyToolBindBudget()`. Hot-load tools are bound directly every turn; lazy
tools need an explicit invocation hop and are for rare or heavy capabilities.
Per-tool credentials arrive as `AgentRunConfig.tool_credentials` and are
resolved only by the wrapper. Tests:
`lib/tools/runtime/tool-bind-budget.test.ts` and catalog tests.

### 4. Stream and retry safely

`transientRetryStream()` and `stallRetryStream()` live in
[run-retry.ts](./run-retry.ts), with `rateLimitRetryDelayMs()` and
`shouldRetryTransientError()`. Preserve the chunk contract above; never forward
heartbeats, and never treat a retry as a fresh turn that may repeat writes.
Tests: [run-thread.retry.test.ts](./run-thread.retry.test.ts),
[llm.stream-stages.test.ts](./llm.stream-stages.test.ts).

### 5. Bound context and compact

`computeContextBudget()` owns the token split;
`buildHistoryWindow()` in [prepare/history-window.ts](./prepare/history-window.ts)
assembles the window, with `takeRecentMessagesWithinBudget()`,
`takeRecentTurnsWithinBudget()`, and `truncateLargestMessagesWithinBudget()`.
Warm summaries use `warmSummaryMessageLimit()`; compaction and summaries live in
[compaction-pipeline.ts](./compaction-pipeline.ts) and
[conversation-summary.ts](./conversation-summary.ts). Tests:
[context-boundary.test.ts](./context-boundary.test.ts),
[run-thread.auto-boundary.test.ts](./run-thread.auto-boundary.test.ts),
[thread-compaction.test.ts](./thread-compaction.test.ts).

### 6. Idle dreaming (ADR-0135)

- Light dreams move the context boundary through the exact-boundary service and
  never prune messages; retention stays cap-driven.
- The preflight is local-only: no running/queued turn, no pending compaction,
  unlocked, idle long enough, at least the configured number of new user turns,
  not already dreamed in this idle window, and within the daily run/token
  budget.
- Deep maintenance runs only for the default agent, archives (never deletes)
  expired or exact-duplicate facts, and bounds every document phase with a
  wall-clock budget.
- Near-duplicate merges are an explicit model step: the model returns a strict
  JSON proposal; code validates the survivor key, schema, weakest confidence,
  expiry agreement, and fingerprints, then dry-runs and applies via
  `applyMemoryMaintenance`. Toggle with `deep_merge_enabled`.
- Write outcomes to `agent_dream_state` / `agent_dream_runs`; never write a chat
  row or notification from a dream. Tests: [dreaming.test.ts](./dreaming.test.ts).

## Anti-patterns

- **Unregistered agents or tools** — an arbitrary object or uncatalogued name
  cannot be discovered, audited, or authorized. Bind through the catalog.
- **Credentials in prompts or raw credential objects** — leaks through logs,
  model output, and provider caches. Pass credential ids to wrappers.
- **Unbounded history or budget bypass** — causes context overflow and stalls
  every turn. Use the context budget and history window.
- **Ignoring stream semantics** — rendering heartbeats, treating `reset_text`
  as append, or missing an error chunk leaves clients and storage inconsistent.
- **State mutations without checkpointing** — a crash cannot resume and may
  replay side effects.
- **Retrying after abort or replaying writes** — a retry is not a new turn.
- **Duplicating routing or permission logic** — nodes and tools must consume the
  resolved model, permission map, and budgets, not recalculate them.

## File map

| Concern | Files |
| --- | --- |
| Turn orchestration | [base.ts](./base.ts), [run-thread.ts](./run-thread.ts), [llm.ts](./llm.ts), [run-queue.ts](./run-queue.ts), [run-registry.ts](./run-registry.ts), [abort-reason.ts](./abort-reason.ts), [run-retry.ts](./run-retry.ts) |
| Prepare and context | [prepare/](./prepare/), [context-budget.ts](./context-budget.ts), [compaction-pipeline.ts](./compaction-pipeline.ts), [conversation-summary.ts](./conversation-summary.ts), [thread-compaction.ts](./thread-compaction.ts), [warm-summary-background.ts](./warm-summary-background.ts) |
| Models and budgets | [model-router.ts](./model-router.ts), [effective-model.ts](./effective-model.ts), [usage-strategy.ts](./usage-strategy.ts), [usage-profile.ts](./usage-profile.ts), [delegation-budget.ts](./delegation-budget.ts) |
| Prompts and validation | [prompt-registry.ts](./prompt-registry.ts), [prompt-variants.ts](./prompt-variants.ts), [prompt-eval/](./prompt-eval/), [output-validator/](./output-validator/), [citation-checker.ts](./citation-checker.ts), [hallucination-classifier.ts](./hallucination-classifier.ts) |
| State and streaming | [checkpointer.ts](./checkpointer.ts), [sqlite-checkpoint-saver.ts](./sqlite-checkpoint-saver.ts), [agent-turn.ts](./agent-turn.ts), [transcript-draft.ts](./transcript-draft.ts), [tool-outcomes.ts](./tool-outcomes.ts), [stream-collector.ts](./stream-collector.ts) |
| Dreaming | [dreaming.ts](./dreaming.ts) (ADR-0135) |

## Testing requirements

- Co-located Vitest tests use `*.test.ts` and `vi` (not jest). Give each file a
  temporary `JARELA_DB_DIR`; mock provider and tool boundaries.
- Unit: [model-router.test.ts](./model-router.test.ts),
  [context-budget.test.ts](./context-budget.test.ts),
  [context-boundary.test.ts](./context-boundary.test.ts),
  [run-queue.test.ts](./run-queue.test.ts),
  [tool-outcomes.test.ts](./tool-outcomes.test.ts).
- Thread integration: [run-thread.test.ts](./run-thread.test.ts) and its retry,
  stages, and auto-boundary siblings; assert chunk types, persistence, and
  cancellation.
- Streaming: [llm.stream-stages.test.ts](./llm.stream-stages.test.ts),
  [stream-collector.test.ts](./stream-collector.test.ts); cover heartbeat and
  `reset_text` behavior.
- Tool binding: `lib/tools/runtime/tool-bind-budget.test.ts` plus catalog and
  credential-routing tests.
- Prompt changes: [prompt-registry.test.ts](./prompt-registry.test.ts),
  [prompt-eval/](./prompt-eval/), and `npm run test:prompts`.
- Dreaming: [dreaming.test.ts](./dreaming.test.ts).
- Run the focused Vitest files, `npx tsc --noEmit`, and `npm run lint`.

## Review checks

- [ ] The turn is resumable and every state mutation is checkpointed.
- [ ] Tool binding uses the permission map and catalog; credentials stay in the
      wrapper.
- [ ] Every chunk type is consumed correctly; terminal, heartbeat, and
      `reset_text` rules are preserved.
- [ ] Context budget and history window are applied; no unbounded history.
- [ ] Retry and abort behavior is tested; no writes are replayed.
- [ ] Prompt registry, eval, and dump output are updated for prompt changes.
- [ ] New chunk types or event shapes update collectors and tests.
- [ ] Focused tests, `npx tsc --noEmit`, and `npm run lint` pass.
