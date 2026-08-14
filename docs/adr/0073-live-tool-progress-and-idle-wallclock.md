---
status: "accepted"
date: 2026-08-14
deciders: example-user
consulted:
informed:
---

# Live tool progress via LangGraph custom-stream events + idle-reset wallclocks

## Context and Problem Statement

`claude_delegate` ([lib/tools/claude-delegate.ts](../../lib/tools/claude-delegate.ts), ADR-0071) spawns a local `claude` CLI process that already parses its own `stream-json` output into turn-by-turn steps (`extractSteps`), but nothing surfaced those steps to the chat UI while the call was still running — the delegating agent only saw a final result once the call resolved (foreground), or had to manually poll `claude_delegate_status` and relay steps in its own prose (background).

Separately, `claude_delegate` has two independent timeout mechanisms, both fixed-total-duration rather than idle-based: its own subprocess SIGTERM timer (`spawnClaude`, keyed off `timeout_seconds`, default 600s) and the generic per-tool-call outer wrapper (`wrapWithWallclock` in [lib/tools/wallclock.ts](../../lib/tools/wallclock.ts), default 120s `deadline_ms`, abandons the JS promise without killing the subprocess). Both exist purely to catch a genuine stall — neither should cap a healthy long-running task that's still visibly doing work.

## Decision Drivers

* Users want to watch a delegated Claude Code session work, inline in the chat, for both foreground and background calls.
* A wall-clock budget's job is to catch silence, not to cap total duration — "if there is any change/action, the wallclock should reset."
* CLAUDE.md invariant: reuse existing patterns; favor simplicity over inventing new plumbing.
* Don't regress tools that never adopt progress reporting — their existing synthetic wallclock progress bar (ToolList.tsx) must keep working unchanged.

## Considered Options

**Delivery mechanism for live progress:**
* **(A) Frontend polling** `claude_delegate_status`, merged into the tool card the same way `lib/tools/wallclock.ts`'s `async_run`/`tool_result_get` handoff is already merged in `components/chat/ToolList.tsx` (bg/read badges). Reuses an existing precedent, ~1-2s granularity, no backend interface change.
* **(B) Run-registry reach-through** — a tool imports `lib/agents/run-registry.ts` directly and calls `getRun(thread_id)` / `broadcast()` itself. Works, but a tool reaching into the SSE-broadcast layer directly is a layering violation, and bypasses the generator abstraction `lib/agents/llm.ts` otherwise owns.
* **(C) LangGraph's native custom-stream channel** *(chosen)* — every tool's `config` (really the `runtime` object LangGraph's `ToolNode` constructs) already carries `writer: config.writer ?? config.configurable?.writer ?? null` and `toolCallId: call.id`. Calling `config.writer(chunk)` pushes synchronously onto the graph's shared stream as `[ns, "custom", chunk]` as soon as it's called (confirmed in `@langchain/langgraph`'s pregel loop — chunks are yielded "as soon as they are generated," not batched until the node completes). `agent.stream()` just needs `"custom"` added to `streamMode`.

**Wallclock reset scope:**
* Reset only `claude_delegate`'s own subprocess timer — directly fixes the motivating case but leaves the generic wrapper's footgun (a foreground call abandoned mid-flight while its subprocess runs on, orphaned) unaddressed.
* **Reset both, via the same signal** *(chosen)* — the subprocess timer AND the generic `wrapWithWallclock` deadline both reset off the same `config.writer()` call, so any current or future tool that adopts progress reporting gets idle-reset semantics for free.

## Decision Outcome

Chosen: **(C) LangGraph custom-stream channel**, with **both wallclocks reset off the same signal**.

* **New interface**: `StreamChunk`/`SSEEventType` gain a `tool_progress` variant — `{ id, name, text }`, `id` matching the call's `tool_call`/`tool_result` id. Zero or more can arrive between a call's `tool_call` and `tool_result`.
* **Wiring**: `lib/agents/llm.ts`'s single `agent.stream()` call site adds `"custom"` to `streamMode`; its existing mode-discriminated loop gets one more branch converting a custom payload into a `tool_progress` chunk. No new run-registry plumbing — `broadcast()` already fans out every yielded `StreamChunk` unchanged, and the SSE route already flattens `{ type, ...data }` generically for every chunk type.
* **Tool-facing API**: `lib/tools/workspace-context.ts` exports `reportToolProgress(config, name, text)` — a one-line call to `config.writer({ id: config.toolCallId, name, text })`. `ToolConfig` gained `writer`/`toolCallId` to match what LangGraph's `ToolNode` actually populates. Any tool can adopt this; today only `claude_delegate` does, for both its foreground (`runClaude`) and background (`job.onStep`) paths.
* **Idle-reset, one mechanism for both timers**: `lib/tools/wallclock.ts` wraps the `config` it forwards into the inner tool's `.invoke()` so that calling `config.writer(...)` transparently resets `wrapWithWallclock`'s own deadline timer *before* forwarding the chunk to the caller's original writer — in both the sync-race path and the `async_run` path. `claude-delegate.ts`'s own `spawnClaude` subprocess timer becomes an `armTimer()` reset on every `stdout` `"data"` event (not just successfully-parsed steps — any output proves liveness), independent of the wrapper.
* **Frontend**: `components/chat/ToolList.tsx`'s `ToolCallGroup` gains `steps: string[]`; a `tool_progress` event pushes onto it. The latest step renders inline (collapsed, `ThinkingLine`-style truncated preview) without needing to expand the card; the full history renders in the existing expand panel. Once `steps.length > 0`, the synthetic time-based `ProgressBar` is replaced by a step-count indicator — a percent-toward-deadline bar is actively misleading once that deadline is idle-reset (it would read "almost overdue" on a call that's actually healthy). Tools that never report progress are unaffected — they keep the original bar.

### Consequences

* Good — no new backend plumbing beyond a 3-line generator branch and a 1-line `streamMode` change; the delivery mechanism is LangGraph's own intended use of `"custom"` stream mode, not a bespoke workaround.
* Good — works uniformly for foreground and background `claude_delegate` calls, and for any future tool that adopts `reportToolProgress` — not a claude-delegate special case.
* Good — the idle-reset wallclock genuinely fixes the "why did it die, it was still working" complaint, for both the subprocess-killing timer and the generic per-call budget.
* Neutral — a tool that reports progress very frequently (e.g. every few ms) would reset its outer wallclock into an effectively unbounded call. Not a concern for `claude_delegate` (steps arrive per Claude turn, seconds apart at minimum); a future adopter with pathologically frequent progress would need its own judgment call.
* Bad — `wrapWithWallclock`'s config-forwarding now does one extra object spread per call to install the reset hook; negligible cost, but worth noting as the wrapper's forwarding path is no longer a bare pass-through.

## More Information

* [ADR-0071 — Claude Code delegation tool](0071-claude-code-delegation-tool.md) — the motivating consumer.
* [ADR-0034 — customizable env allowlist + subprocess injection](0034-customizable-env-allowlist.md) — unrelated mechanism, but the same file (`lib/tools/wallclock.ts`) and the same "layer generic behavior into the wrapper, not into each tool" instinct.
* `node_modules/@langchain/langgraph/dist/pregel/index.cjs` — `config.writer` construction and the `"custom"` stream-mode push, confirmed to be synchronous and immediate rather than batched.
