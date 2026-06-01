---
status: "proposed"
date: 2026-06-01
deciders: example-user
---

# ADR-0039: Decompose `prepareThreadRun` into request adapter + system-prompt builder

## Context and Problem Statement

[`prepareThreadRun`](../../lib/agents/run-thread.ts) is the single entry
point that turns "a user (or trigger, or bridge) sent a turn" into "an
async stream of `StreamChunk`s." It runs on every chat message,
scheduled-task firing, watcher trigger, bridge inbound, and delegated
sub-agent invocation.

Today the function:

1. Accepts **7 positional parameters** — `thread_id`, `message`,
   `options`, `attachments`, `signal`, `_stallRetriesLeft`,
   `userCategory`, plus two more (`_delegationDepth`,
   `_delegationAncestors`) added later. Two of these are public (caller
   sets), six are internal control state, and the line between them is
   a comment, not a type.
2. Spans **313 lines** doing eight visibly-distinct jobs: thread/agent
   lookup, history slicing + budgeting, profile/location formatting,
   env+time blocks, integrations roster, memory + warm-summary +
   facts + recall race, harness resolution, delegate roster,
   system-prompt assembly, stream wrapping.
3. Is called from **five distinct sites** — the API route, the
   triggers/scheduler runner, the bridges dispatcher, the
   `delegate_to_agent` tool, and a recursive self-call inside
   `stallRetryStream`. Each caller writes the same positional invocation
   with `undefined` placeholders for the args it doesn't use.

The audit (Q2 2026) flagged this as the structural epicenter of the
agent runtime — most other "spaghetti" findings (long-distance JSON
parsing, multiple-entry-path adapter quirks) feed into or out of this
function.

## Decision Drivers

* Five callers + two layers of internal state can't keep using positional
  args without the type system actively misleading us. The next
  parameter added (a sixth control flag for some new feature) just
  pushes "what does that `undefined` mean" further into folklore.
* Eight responsibilities in one function blocks unit testing of the
  obvious pure parts (system-prompt assembly is referentially
  transparent — given the same thread/agent/options it produces the same
  string — and yet has zero direct tests).
* Decomposition is purely mechanical when the seams are at "what builds
  the system prompt" vs "what runs the stream." The two halves are
  already conceptually separate; only their colocation in the same
  function ties them together.
* The output validator (ADR-0037) and capability axis (ADR-0038) sit
  *around* `prepareThreadRun`. Their boundaries get clearer when the
  function inside has a tighter shape.

## Considered Options

1. **`ThreadRunRequest` object + extracted `buildSystemPrompt` /
   `buildHistoryWindow` modules (this ADR).** Replace the 7 positional
   args with a typed request object; pull the system-prompt assembly
   and history-window construction into their own modules. Keep
   `prepareThreadRun` as a slim orchestrator.
2. **Builder-pattern fluent API** —
   `runThread(thread_id).withMessage(m).withCategory(c).submit()`.
   Reads nicely at the call site but adds an entire object lifecycle for
   what is fundamentally a single-shot function call.
3. **Split into multiple top-level entry points per source** —
   `runUserTurn`, `runScheduledTask`, `runDelegation`, `runBridgeMessage`.
   Each absorbs its own quirks. Eliminates positional args by having
   different signatures per caller. But every entry point still needs
   the same prompt + history + stream pipeline, so the duplication
   reappears one layer down.
4. **Leave the 7 positional args, just split the prompt builder out.**
   Most of the value with less surface change. Loses the type-level
   benefit — the next caller variation still writes
   `undefined, undefined, undefined`.

## Decision Outcome

Chosen option: **1**, because:

* The request object kills the `undefined`-placeholder pattern at every
  call site, making each caller's intent explicit. Internal control
  fields (`_stall_retries_left`, `_delegation_depth`,
  `_delegation_ancestors`) become obvious as private; public fields
  (`thread_id`, `message`, etc.) become obvious as public.
* `buildSystemPrompt` becomes a pure function: `(agentCfg, ctx,
  options) => string`. Now testable directly, and the dependency graph
  in the new file makes the eight context blocks visible side-by-side
  instead of scrolling through 200 lines of inline assembly.
* `buildHistoryWindow` likewise: `(thread_id, agentCfg, providerParams)
  => { history, hotMessages, allWindowMessages, budget }`. Pulls the
  history-slicing + warm-summary + facts + tier ordering out of the
  orchestrator.
* The orchestrator `prepareThreadRun` collapses to ~80 lines: validate
  request → resolve thread/agent/model → persist user message → build
  history → build prompt → stream. That's the function description on
  the tin.
* Builder-pattern (option 2) is overkill for a once-per-turn call.
  Per-source entry points (option 3) just move the quirks one level down.
  Partial split (option 4) leaves the type-level problem unresolved.

## Decision details

### `ThreadRunRequest`

New file `lib/agents/prepare/request.ts`:

```ts
export interface ThreadRunRequest {
  thread_id: string;
  message: string;
  options?: StreamOptions;
  attachments?: ContentPart[];
  signal?: AbortSignal;
  user_category?: string | null;

  // Internal control — public callers leave undefined. Documented in
  // the type so it's visible to anyone reading.
  _stall_retries_left?: number;
  _delegation_depth?: number;
  _delegation_ancestors?: readonly string[];
}
```

`prepareThreadRun(req: ThreadRunRequest): Promise<PreparedThreadRun>`.
The `_`-prefix on internal fields keeps the visual signal "don't set
this from outside" without TypeScript's `private` (which we can't apply
to interface fields).

### `buildSystemPrompt`

New file `lib/agents/prepare/system-prompt.ts`. Exports:

```ts
export interface SystemPromptContext {
  agentCfg: AgentConfigRow;
  budget: ContextBudget;
  recallCtx: string;
  warmSummaryCtx: string;
  factsCtx: string;
  experienceMode: "essential" | "full";
  delegateRosterLines: string[]; // empty when no delegates allowed
}

export function buildSystemPrompt(ctx: SystemPromptContext): string;
```

Internal helpers (file-private):

* `buildUserContext(profile)` — name + about + opt-in location
* `buildEnvContext()` — platform, paths, file-tool resolution rules
* `buildIntegrationsContext()` — configured integrations roster
* `buildMemoryContext(budget)` — memory + recall preamble
* `buildExperienceContext(mode)` — UX-mode block
* `buildDelegatesContext(lines)` — only when `lines.length > 0`

Each helper returns a string or `""`; the top-level function joins them
with `\n\n` after filtering empties — same shape as the inline
`systemParts.filter(Boolean).join("\n\n")` today.

### `buildHistoryWindow`

New file `lib/agents/prepare/history-window.ts`. Wraps
`getRecentMessagesWindow` + `computeContextBudget` +
`takeRecentMessagesWithinBudget` + `buildWarmSummaryContext` +
`buildFactsContext` + tier ordering. Returns:

```ts
export interface ResolvedHistoryWindow {
  history: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>;
  budget: ContextBudget;
  warmSummaryCtx: string;
  factsCtx: string;
}

export function buildHistoryWindow(
  thread_id: string,
  agentCfg: AgentConfigRow,
  providerParams: ProviderParams,
  trimmedMessage: string,
): Promise<ResolvedHistoryWindow>;
```

### Orchestrator shape

After the split, `prepareThreadRun` reads in roughly this order:

```ts
export async function prepareThreadRun(req: ThreadRunRequest): Promise<PreparedThreadRun> {
  startScheduler();
  const { thread, agentCfg, modelCfg, providerParams } = resolveRunContext(req);
  const trimmed = persistUserMessage(req, agentCfg);

  const historyWindow = await buildHistoryWindow(req.thread_id, agentCfg, providerParams, trimmed);
  const recallCtx = await raceWithBudget(buildRecallContext(...), RECALL_BUDGET_MS, "");
  const allowedTools = getAgentTools(agentCfg);
  const delegateRosterLines = buildDelegateRoster(agentCfg, allowedTools);

  const systemPrompt = buildSystemPrompt({
    agentCfg, budget: historyWindow.budget,
    recallCtx, warmSummaryCtx: historyWindow.warmSummaryCtx,
    factsCtx: historyWindow.factsCtx,
    experienceMode: resolveExperienceMode(req.options),
    delegateRosterLines,
  });

  const stream = streamWithConfig(req.thread_id, historyWindow.history, {
    ...req.options,
    agent_run_config: { system_prompt: systemPrompt, allowed_tools: allowedTools, ... },
  }, req.signal);

  return {
    stream: stallRetryStream(stream, req, allowedTools),
    thread_id: req.thread_id,
  };
}
```

That's the whole function — every step is one to three lines of obvious
work, and every helper has a name that tells you what it does.

### Caller migration

Five sites update from positional to request-object:

| Site | Today (positional) | After (request) |
|------|--------------------|------------------|
| `app/api/v1/threads/[thread_id]/run/route.ts:60` | 5 args | `{ thread_id, message, options, attachments, signal }` |
| `lib/triggers/runner.ts:44` | 7 args | `{ thread_id, message, user_category }` |
| `lib/bridges/dispatcher.ts:72` | 7 args | `{ thread_id, message, attachments, user_category: "bridge" }` |
| `lib/tools/delegate.ts:76` | 9 args | `{ thread_id, message, user_category: "delegation", _delegation_depth, _delegation_ancestors }` |
| `lib/agents/run-thread.ts:559` (recursive) | 6 args | `{ ...originalReq, message: nudge, _stall_retries_left }` |

No behavior change at any caller. The output validator,
adaptive-persona, harness resolver, capability registry, and embedding
recall are all untouched.

### Test impact

* New unit tests for `buildSystemPrompt` cover the eight context blocks
  with table-driven cases — first time these blocks have direct tests.
* Existing `proposals.test.ts` and `adaptive-persona.test.ts` are
  unaffected (they don't call `prepareThreadRun` directly).
* The embeddings test mock for `model-config` (already touched in the
  #5 PR for `getModelParams`) stays as-is.

### Out of scope

* Splitting `prepareThreadRun` into per-source entry points (option 3).
  Possible future move, but the request object alone removes the
  positional-args pain. Don't pre-emptively shape an interface for
  callers we don't have.
* Pulling stream-wrapping (`stallRetryStream`, `persistAssistantMessage`)
  out into its own file. They're already short and tightly coupled to
  the output validator. Move them once the validator grows beyond regex
  checks.
* Refactoring the per-source caller adapters (the
  `formatBridgePrompt` / `[SILENT_TRIGGER]` wrapping that the audit also
  flagged). The request object opens the door for a shared adapter
  layer, but that's its own change.

## Consequences

* Good — `prepareThreadRun` becomes ~80 lines of obvious orchestration.
  The system-prompt builder is testable in isolation. Caller intent is
  visible at the type level.
* Good — adding a new caller path or a new internal control flag is now
  an additive field on `ThreadRunRequest`, not a positional arg shift.
* Good — system-prompt context blocks become independently editable.
  The capabilities/plan-first/citation harness sections (ADR-0033) sit
  next to the user/env/integrations blocks side-by-side instead of
  scrolling through inline literals.
* Bad — five caller sites rewrite their invocation, plus the recursive
  self-call. Mechanical but wide.
* Bad — adds three new files
  (`prepare/request.ts`, `prepare/system-prompt.ts`,
  `prepare/history-window.ts`). One more directory in `lib/agents/`.
* Neutral — runtime behavior unchanged. The output stream a caller
  observes is byte-identical to today (modulo any unintentional drift,
  which the test suite catches).

## More Information

* Affected runtime path:
  [lib/agents/run-thread.ts](../../lib/agents/run-thread.ts) —
  `prepareThreadRun`. Five caller sites.
* Related: [ADR-0033](0033-configurable-harness.md) (harness sections —
  these *are* part of the system prompt builder),
  [ADR-0037](0037-agent-output-validator.md) (output validator runs
  after the stream wrapper, untouched here),
  [ADR-0038](0038-tool-capability-axis.md) (capability axis — orthogonal).
