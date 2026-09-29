---
status: "accepted"
date: 2026-09-29
deciders: Andrew Wu
---

# 0089 - Thread the run's AbortSignal into every provider SDK call

## Context and Problem Statement

Hitting Stop (or the last client disconnecting) aborts the `AbortController`
in `lib/agents/run-registry.ts`, which is passed into LangGraph's
`agent.stream(..., { signal })`. That only stops the app from consuming
further chunks from the Pregel loop — it never reached the actual HTTP
call to Anthropic/OpenAI/Gemini/Copilot. `ModelProvider.chat/invoke/streamInvoke`
(the `@public` provider extension contract in `lib/providers/types.ts`) has
no `signal` parameter at all, so even though LangChain's `BaseChatModel`
correctly threads `RunnableConfig.signal` into `ParsedCallOptions` (verified:
`ParsedCallOptions` explicitly retains `signal`/`timeout`/`maxConcurrency`
from `RunnableConfig`), `JarelaChatModel._generate`/`_streamResponseChunks`
never read it — the options parameter was prefixed `_options` to mark it
deliberately unused.

Net effect: Stop stops the UI from updating, but the provider keeps
generating (and billing) tokens, and any tool call already dispatched keeps
running to completion server-side.

A related, compounding bug: `stallRetryStream` in `lib/agents/run-thread.ts`
detects a tool-call loop and `break`s out of the consumer loop, then starts
an entirely new attempt via `prepareThreadRun`. Breaking a `for await` loop
closes the local iterator but — even once the signal reaches the SDK call —
does nothing to cancel the *old* attempt's request, since nothing calls
`.abort()` on it. The abandoned attempt and the new retry could run
concurrently, including re-executing the same tool call.

## Decision Drivers

* Stop must actually stop billed provider work and in-flight tool calls, not
  just the UI's view of them.
* The fix must not break existing external `~/.jarela/providers/*.cjs`
  provider plugins, which conform to the `@public` `ModelProvider` contract.
* Prefer the smallest change that closes the gap — no new transport/queueing
  layer.

## Considered Options

* Add an optional trailing `signal?: AbortSignal` parameter to
  `ModelProvider.chat`/`.invoke`/`.streamInvoke` and thread it through every
  in-tree vendor adapter.
* Leave the public interface alone; only fix the primary Anthropic path.
* Introduce a provider-level timeout-only cancellation (no true user-driven
  abort), relying on existing idle/wall-clock watchdogs in `run-registry.ts`.

## Decision Outcome

Chosen option: **add an optional trailing `signal?: AbortSignal`** to all
three `ModelProvider` methods. It's additive and backward-compatible —
TypeScript structural typing allows an implementation to declare fewer
parameters than the interface, so an existing external `.cjs` provider that
doesn't accept the new argument remains a valid `ModelProvider`; it simply
keeps not supporting cancellation (no regression, same as today).

Changes:
- `lib/providers/types.ts`: `signal?: AbortSignal` added to `chat`, `invoke`,
  `streamInvoke`.
- `lib/providers/jarela-chat-model.ts`: `_generate`/`_streamResponseChunks`
  now read `options.signal` (renamed from `_options`) and forward it through
  `_streamToFinalChunk` → `_streamFromProvider` → `provider.streamInvoke`,
  and directly into `provider.invoke`/`provider.chat`.
- Every in-tree adapter passes `signal` into its underlying call's own
  cancellation mechanism: `{ signal }` as the second argument to the
  Anthropic SDK's `client.messages.stream()`/`.create()` and the OpenAI
  SDK's `client.chat.completions.create()` (covers `anthropic.ts`,
  `openai.ts`'s `openaiProvider` + `makeOpenAICompatProvider` — which
  `deepseek.ts` and Gemini's OpenAI-compat fallback reuse — and
  `github-copilot.ts`'s both Claude-native and OpenAI-compat paths).
- `gemini.ts`'s native `fetch()` calls previously hardcoded
  `signal: nativeFetchSignal()`, a fixed 10-minute `AbortSignal.timeout()`
  unrelated to cancellation. `nativeFetchSignal` now takes the caller's
  signal and merges it with the timeout via `AbortSignal.any([...])`, so
  neither the timeout nor caller-driven cancellation is lost.
- `mock.ts` (the test/offline provider) now honors the signal via
  `signal?.throwIfAborted()` at each yield point, so provider-level abort
  behavior has genuine end-to-end test coverage instead of only being
  asserted at the interface-shape level.
- `lib/agents/run-thread.ts`: `prepareThreadRun` creates a per-attempt
  `AbortController` chained from the caller's own `req.signal` (so Stop
  still works normally) and passes its `.signal` into `streamWithConfig`
  instead of `req.signal` directly. `stallRetryStream` receives this
  controller and calls `.abort("stall_retry")` immediately before starting
  a stall/loop retry via `prepareThreadRun`, so the abandoned attempt's
  in-flight provider call is genuinely cancelled rather than left running
  behind the new attempt.

### Consequences

* Good, because Stop (and client disconnect) now cancels the actual
  provider HTTP call, not just the app's consumption of it — no more
  phantom billed generation or orphaned tool execution after Stop.
* Good, because a detected tool-call loop can no longer race a duplicate
  retry attempt against the abandoned original.
* Good, because the change is additive to the `@public` provider contract —
  no external plugin breaks.
* Neutral, because embeddings (`ModelProvider.embed`) and `listModels` are
  unaffected — they're not part of a cancellable chat turn.
* Bad, because every in-tree vendor adapter needed a mechanical edit; drift
  is possible if a future adapter forgets to wire the parameter through to
  its SDK call. Mitigated by `jarela-chat-model.test.ts`'s forwarding tests
  and `mock.test.ts`'s end-to-end abort test, but there's no repo-wide check
  that a *new* adapter actually uses the signal it receives.

## More Information

Identified via a full-codebase LLM-interaction review (2026-09-29) alongside
the memory-compaction fixes in ADR-0088's follow-up work. See
`lib/providers/jarela-chat-model.test.ts` ("abort signal forwarding"),
`lib/providers/mock.test.ts` ("stops streaming once the caller's AbortSignal
fires"), and `lib/agents/run-thread.retry.test.ts` ("aborts the stalled
attempt's own signal before starting the tool-loop retry") for the
regression coverage this ADR's fix is backed by.
