---
status: accepted
date: 2026-06-02
deciders: andwu, claude
---

# Central tool dispatch + ToolResult discriminated union

## Context and Problem Statement

Tool invocation today happens through three independent paths with three independent return shapes:

1. The agent loop's internal `t.invoke(args, config)` from inside LangGraph's react agent.
2. `executeTool(name, args, ctx)` in `lib/tools/index.ts` for non-agent callers (proposals, watcher, etc.).
3. Direct calls inside specialized code paths (e.g. delegate, approval flows).

The historical contract was "tool returns a string per LangChain convention; we'll JSON.parse it on best-effort". In practice tools also return:
- `{error: "..."}` JSON envelopes (heuristically detected by `isErrorPayload` in the chat UI)
- raw markdown / prose
- Numbers / booleans
- Already-parsed objects when calling through `executeTool`

Downstream consumers (chat UI, tool-call rendering, agent's own next-turn input) had to interpret each tool's idiosyncratic shape. With the new long-task directive, this fragility compounds: across hundreds of tool calls in a single task, even a 1% misinterpretation rate produces multiple silent corruptions per task.

There is also no central observability. Debugging "what happened in this turn" today requires log-scraping across modules — there's no single place that records `(run_id, tool, started, ended, status, duration)`.

External tools have an additional gap: their wrapper in `lib/tools/external.ts` accepts raw `args` from LangChain's `tool()` invocation without re-validating against the declared schema. LangChain validates on *serialization* (the function-calling payload sent to the model), not on `.invoke()`. A user-authored plugin therefore had a hole where the agent could pass anything matching the LLM's serialized intent.

## Decision Drivers

* **One shape, one chokepoint.** Adding a fifth tool category shouldn't require new heuristics in every consumer.
* **Don't migrate every tool in one PR.** Existing tools return what they return today; the boundary is enforced at dispatch, not at the emit site.
* **Cheap observability.** Every tool call must log a structured entry without a DB write per call.
* **Close the external-tools validation gap.** Without rewriting LangChain's validation pipeline.

## Considered Options

### Result shape

* **(A) Keep `unknown`-typed returns; consumers detect.** Status quo.
* **(B) ToolResult discriminated union, normalised at one chokepoint.**
* **(C) Per-tool typed return, enforced at registration via generics.** Most type-safe; biggest migration cost.

### Dispatch placement

* **(α) Wrap every tool's `.invoke` at registration time.** Catches the agent loop too.
* **(β) Provide a central dispatch helper, opt in callers gradually.**
* **(γ) Both — wrap at registration AND expose the helper for new callers.**

### External-tools validation

* **(i) Re-parse zod schema in the `tool()` wrapper before delegating to user code.**
* **(ii) Require external tools to opt-in to validation.**

## Decision Outcome

Chosen options: **(B) ToolResult union normalised at the central dispatch + (β) helper-now, full wrap-at-registration as a follow-up + (i) zod re-parse for external tools**.

(B) over (C): the migration cost of typing every tool's return at the source is real and not justified by today's failures. Normalising at the boundary catches the same misinterpretations consumers care about while leaving the tool authors' code unchanged.

(β) over (α) / (γ) for THIS PR: wrapping at registration affects the agent's hot path through LangGraph and deserves a focused follow-up with tighter integration testing. The helper covers the proposals path (where the current heuristic JSON-parse lived) and provides the shape for future callers.

(i) closes the external-tools validation gap with the smallest possible change: the wrapper re-parses zod-shaped schemas in `tool()`'s callback, returning a structured `invalid_args` error envelope when validation fails. Tools using plain JSON Schema fall through unchanged (LangChain's outer serialization still applies).

### Consequences

* Good — `ToolResult` is now the typed boundary contract. New callers (and the chat UI's tool rendering, after a follow-up) can branch on `kind` instead of detecting shapes.
* Good — `runToolDispatched` produces a structured log entry per call, in-memory ring buffer (capped at 500), grep-friendly console line. Future debug surface gets it for free.
* Good — external tools that declare a zod schema can no longer be called with unvalidated args; tools that declare plain JSON Schema retain their existing behaviour.
* Good — additive: existing tool authors don't change anything; existing callers see backward-compatible "raw" returns via `toLegacyShape`.
* Bad — the agent loop's internal calls don't yet go through dispatch. Tagged for follow-up: wrap at `registerTools` so the LangGraph path also emits structured logs.
* Bad — a tool that already returned a `{kind: "..."}` envelope (none today, but possible in the future) now needs to use the canonical kinds. Mitigated by the normaliser explicitly recognising only `"json" | "text" | "error"`.

## Pros and Cons of the Options

### (B) ToolResult union (chosen)

* Good — explicit at the boundary; consumers can branch without heuristics.
* Good — backward-compatible: `toLegacyShape` produces today's raw payload for unmigrated callers.
* Neutral — adds a normaliser. Roughly the same code as today's heuristic, just centralised.

### (C) Per-tool typed return

* Good — most type-safe; a tool's signature documents its result.
* Bad — invasive: every tool file changes; LangChain's `tool()` signature doesn't natively support a typed-result return.

### (β) Helper-now (chosen)

* Good — small, focused PR. No risk to the agent's hot path.
* Good — composes with the existing `withToolTimeout` from PR-1.
* Bad — leaves the agent loop's invocations unmonitored until the follow-up.

### (i) zod re-parse in wrapper (chosen)

* Good — closes the validation gap with one small block.
* Good — degrades gracefully on tools using JSON Schema (LangChain's serialization still applies).
* Neutral — duck-types schemas as zod (presence of `parse` + `safeParse` + `_def`) so plugins bringing their own zod copy still validate.

## Implementation notes

* `lib/tools/dispatch.ts` exports `runToolDispatched(runFn, opts)` and `normalizeToolResult(raw)`. In-memory ring buffer of 500 entries; `recentDispatchLog(limit?)` returns a slice.
* `ToolResult` discriminated union added to `lib/tools/types.ts`.
* `executeTool` routes through `runToolDispatched` and converts back to the historical raw shape via `toLegacyShape`. New typed callers use `executeToolStructured` which returns `ToolResult` directly.
* `lib/tools/external.ts` duck-types a zod schema and re-parses args inside the `tool()` wrapper. Validation failure returns a structured `{error, code: "invalid_args"}` envelope rather than throwing — LangGraph's loop continues and the model can route around.
* Console log format: `[tool-dispatch] tool=<name> thread=<id|-> run=<id|-> status=<ok|error|timeout> dur=<ms>ms [code=...] [msg=...]`. Grep-friendly key=value pairs; no JSON serialization at the call site.
* Cross-references: ADR-0044 (stream-chunk schema — same boundary-contract pattern), ADR-0038 (tool capability axis — orthogonal classification), PR-1's `withToolTimeout` (callers stack timeout outside dispatch).
