---
status: "accepted"
date: 2026-09-04
deciders: example-user
consulted:
informed:
---

# Mid-run user input is steering, not an interrupt

## Context and Problem Statement

Typing into the composer while a turn is running currently kills the turn.
`handleSubmit` prepends the new message to the client queue and then calls
`stopStreaming()`, which aborts the run
([components/chat/useChatSubmitHandlers.ts](../../components/chat/useChatSubmitHandlers.ts)).
The server marks the partial assistant message with `INTERRUPT_MARKER` and the
queue drains into a brand-new turn. Every tool call the aborted turn had already
made is thrown away, and the replacement turn starts from the original request
with no knowledge that the work happened.

The same amnesia appears on the auto-retry path. `stallRetryStream` re-runs a
flagged turn with `buildRetryContextSummary` — 280 characters of prose, at most
eight tool names, and five tool results clipped to 240 characters each. The
retried model cannot verify what already ran, so it repeats it. A turn that had
queued a `propose_config_change` proposal redid an entire review pass.

Both are the same defect: **the agent never sees what it already did.** Users
observe it as the agent doing the work twice.

Mature harnesses treat this as three distinct inputs, not one. The
[Pi coding-agent tutorial][pi-steering] separates *stop* (cancel now), *steering*
(adjust direction, delivered at a safe boundary) and *follow-up* (queue until the
current task settles). Its central claim is the one we violate:

> the next model request contains the tool results and the user's steering
> together. Seeing "the tests failed" alongside "hold off on the tests," the
> model can adjust its plan in one shot, instead of being interrupted with
> incomplete information.

It also names our exact failure mode:

> The most dangerous failure is appending steering directly to messages while
> the current assistant message is still streaming.

We avoid the ordering hazard by discarding the turn entirely — trading a
provider error for lost work.

## Decision Drivers

* Typing must not destroy in-flight work.
* Steering must reach the model *together with* the tool results it should react
  to, never interleaved into a half-streamed assistant message.
* Anthropic requires every `tool_use` block to be immediately followed by a
  matching `tool_result`; any injection point must preserve that pairing.
* The agent loop is LangGraph's prebuilt `createReactAgent`
  ([lib/agents/llm.ts](../../lib/agents/llm.ts)). Replacing it would touch every
  provider path.
* Synthetic messages must stay distinguishable from human input, or the model
  will treat its own nudges as user instructions on later turns.
* Ctrl+Enter follow-up queueing already works and should not change.

## Considered Options

1. **Keep abort-and-requeue.** Zero work, but it is the bug.
2. **Replace `createReactAgent` with a custom graph** exposing suspend/resume
   between tool batches. Full control, but rewrites the core loop.
3. **Turn-boundary steering** via the existing `stallRetryStream` continuation.
   Cheap, but steering waits for the whole turn to finish — a long
   tool chain ignores the user for minutes.
4. **`preModelHook` injection.** The installed LangGraph (1.4.13) already accepts
   a `preModelHook` node that runs before *every* model call inside the loop.

## Decision Outcome

Chosen option: **4, `preModelHook` injection**, because it lands the steering
message at exactly the boundary option 2 would have been built to expose, using
a documented extension point of the prebuilt agent.

The hook runs after `ToolNode` has appended its results and before the next model
call, so injected messages arrive alongside those results and the
`tool_use`/`tool_result` pairing is never split. Options 2 and 3 are rejected as
respectively too invasive and too slow to respond.

### Semantics

| Input | Meaning | Behaviour |
| --- | --- | --- |
| Enter, mid-run | steering | queued, drained by `preModelHook` into the next model call; same turn continues |
| Ctrl+Enter | follow-up | queued, starts a new turn after the current one settles (unchanged) |
| Stop button | interrupt | the only path that aborts the run |

Steering messages are genuine user input, so they persist as ordinary `user`
rows the moment the queue accepts them — before the assistant message that
reacts to them, which keeps the transcript in causal order. Harness-authored
text is different: retry nudges, today discarded via `_skip_persist_message`,
move onto the same rail but carry `category: "synthetic"`, which the message
schema already supports — no migration. Tagging rather than hiding follows the
convention Claude Code uses, where harness-authored turns are marked (`isMeta`,
`isCompactSummary`, `promptSource`) instead of dropped ([transcript
anatomy][cc-transcript]).

Multiple steering messages queued between two model calls are delivered in
arrival order, preserving the user's original wording. They are not merged into
a summary — merging loses intent.

### Consequences

* Good, because in-flight tool work survives a mid-run message.
* Good, because the retry nudge becomes verification ("here is what you already
  did") instead of a blind redo.
* Good, because `postModelHook` and `interruptBefore`/`interruptAfter` become
  available for the stall detector and per-tool interrupt policy later, without
  further structural change.
* Bad, because steering latency is now bounded by the current tool batch rather
  than being instant. This is deliberate: cancelling a running tool mid-write is
  worse than waiting for it.
* Bad, because the client can no longer assume "typing ends the run"; the Stop
  button becomes the only abort and must stay visible whenever a run is active.
* Neutral, because the server-side per-thread run queue
  ([lib/agents/run-queue.ts](../../lib/agents/run-queue.ts)) is unchanged —
  steering is delivered into the *active* run, not enqueued as a new one.

## More Information

* [Interruption, Steering, and Follow-up Tasks][pi-steering] — three semantics,
  the dual-queue model, and the mid-stream append failure mode.
* [Inside a Claude Code Transcript][cc-transcript] — persist everything, tag
  synthetic messages rather than dropping them.
* [The Conversation State Machine][harness-fsm] — `tool_use`/`tool_result`
  pairing invariant and per-tool interruption policy (cancel vs block).
* ADR-0037 records the output validator whose retry path this ADR reuses.

[pi-steering]: https://learn-agent-from-pi.buildwithais.com/en/read/07-steering-followup/
[cc-transcript]: https://hieplam.github.io/memo/posts/claude-code-transcript-anatomy/
[harness-fsm]: https://cli99.github.io/agentic-harness-engineering/05-conversation-state-machine.html
