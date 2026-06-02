---
status: accepted
date: 2026-06-02
deciders: andwu, claude
---

# Provider error classifiers + transient-retry wrapper

## Context and Problem Statement

`lib/agents/llm.ts` has handled three classes of provider failure for a while: LangGraph recursion limit, context-window overflow (with self-correct), and `max_tokens` exhaustion. Everything else falls through to a generic "agent_error" branch that emits the raw stack trace as the error message. The user sees something like `"Anthropic 401 Unauthorized: ..."` or `"fetch failed (cause: ECONNRESET)"` with no recovery guidance, and the agent has nothing actionable to surface.

Concrete pain we measured: a flaky corporate proxy returns `ECONNRESET` for the first attempt of every cold turn. The agent fails. The user retypes their message. The retry succeeds. That's a 100% recoverable class of failure that we treat as catastrophic.

The other unhandled classes are similar:
- **401 / auth errors** — the user needs to fix their API key in Settings; the agent should *not* retry. Today the message is the provider's raw text.
- **429 / rate limits** — auto-retry after `Retry-After` is the canonical fix; today there's no retry, the user has to wait and re-send manually.
- **Billing / insufficient_quota / 402** — same as auth (no retry, surface to user). Different recovery (different account screen). Different friendly message.
- **Model not found / deprecated** — explicit "switch model in Settings". Don't retry.

ADR-0049 introduced the `error_code` field on `tool_result` chunks and ADR-0050 standardised tool error codes. This ADR extends the same vocabulary upstream — provider failures get classified to the same code namespace (`auth_error`, `rate_limit`, `billing_error`, `network_error`, `model_not_found`) and the `error` chunk carries them so the chat UI and the agent's surrounding turn can branch identically.

## Decision Drivers

* **Recovery hints must be specific.** "fetch failed" tells the user nothing; "Network failure reaching the provider. Retrying once after a short delay…" tells them what's happening and that no action is needed.
* **Auto-retry transients.** Network blips and rate-limits are the dominant recoverable failures; not retrying is choosing to lose turns.
* **Don't auto-retry permanent failures.** Auth and billing don't get better with another attempt — burning a second call is cost without benefit.
* **Match the existing stall-retry pattern.** The codebase has one well-tested auto-retry shape (`stallRetryStream` in `run-thread.ts`); a sibling wrapper that mirrors it is easier to reason about than a parallel mechanism.
* **Don't loop on the same failure.** One retry budget; if the second attempt also fails, surface to the user.

## Considered Options

### Classifier placement

* **(A) Inline regex matches inside `lib/agents/llm.ts` catch block.** Mirrors today's `isContextOverflowError` pattern. Tightly coupled to the catch block; hard to test.
* **(B) Pure-function module `lib/agents/provider-errors.ts`.** Tested in isolation. Importable from anywhere (the chat UI's error card in PR-D will need the same classification).

### Auto-retry placement

* **(α) Inside `streamWithConfig` in `llm.ts`.** Re-call `agent.stream()` from the catch block. Problem: the generator may have already yielded chunks before the error fires, and re-running would emit duplicates.
* **(β) Inside `prepareThreadRun` recursion.** Build a `transientRetryStream` wrapper that mirrors `stallRetryStream`'s shape: watches for retryable error chunks, on match recurses through `prepareThreadRun`. The recursion runs the FULL turn again with the same message. Same retry budget pattern, same tested shape.

### Retry budget

* **(i) Single shared budget for stall + transient.** Simpler. But a single turn can hit one of each (provider blip → retry succeeds → model stalls → stall retry kicks in); a shared budget would let those two cases consume each other.
* **(ii) Separate budgets.** One MAX_STALL = 1, one MAX_TRANSIENT = 1. A turn can burn at most one of each before surfacing.

## Decision Outcome

Chosen: **(B) pure-function module + (β) `transientRetryStream` wrapper + (ii) separate budgets**.

`lib/agents/provider-errors.ts` exports `classifyProviderError(message)` returning `{code, message, retryAfterMs?, retryable}` or null. The function runs in priority order (auth > billing > rate_limit > model_not_found > network) so a message containing both "401" and "rate limit" classifies as auth (recovery is different).

`lib/agents/llm.ts`'s catch block calls the classifier after the existing recursion / context / max_tokens branches. On match, it yields a single error chunk with the code + friendly message + optional `retry_after_ms`.

`lib/agents/run-thread.ts` adds `transientRetryStream` next to `stallRetryStream`. It watches for error chunks with `code in {rate_limit, network_error}`. When seen AND retries-left > 0 AND no chunk has been yielded yet (don't replay partial streams), it sleeps for `retry_after_ms` (capped at 60s) and recurses through `prepareThreadRun` with a decremented `_transient_retries_left`. The retry uses the same user message (no nudge — transients aren't the user's fault).

`ThreadRunRequest` gains an internal `_transient_retries_left` field. Like `_stall_retries_left`, public callers leave it undefined; the wrapper passes it through on recursion.

### Consequences

* Good — flaky-network turns now self-heal. The user sees no error, the model just took one extra second.
* Good — rate-limited turns retry against the server's `Retry-After` hint when present.
* Good — auth/billing/model-not-found errors get specific friendly messages that name the recovery path.
* Good — separate budgets mean transient + stall don't consume each other.
* Good — the classifier is pure and testable; PR-D's chat UI can import it to render code-specific affordances on the same vocabulary.
* Bad — auto-retry doubles the cost of a turn that hits a transient. Mitigated by 1-attempt budget + skipping retry mid-stream.
* Bad — regex-based classification can match wrong messages. Mitigated by priority ordering and a comprehensive test suite (~25 cases).
* Bad — the in-memory `console.warn` log when retry fires is the only observability today. Acceptable for this PR; structured retry telemetry can come with the dispatch log table planned in PR-K.

## Pros and Cons of the Options

### (B) Pure-function module (chosen)

* Good — testable in isolation; classifier pattern can grow (new providers, new failure modes) without touching llm.ts internals.
* Good — importable from PR-D's chat UI to render code-specific actions.
* Neutral — adds one file. Small and focused.

### (β) `transientRetryStream` wrapper (chosen)

* Good — mirrors `stallRetryStream`; reviewers already know the shape.
* Good — only touches the run-thread wrapper layer; llm.ts stays unchanged.
* Good — handles the "don't replay partial streams" edge case cleanly via a `yieldedAny` flag.
* Neutral — adds a level of recursion through `prepareThreadRun`. Same as stall-retry.

### (ii) Separate budgets (chosen)

* Good — failures don't consume each other. A real-world flaky turn that also stalls (rare but seen) gets one chance at each.
* Good — easy to tune (env vars per budget).
* Neutral — adds one field to the internal `ThreadRunRequest` shape.

## Implementation notes

* `lib/agents/provider-errors.ts`:
  - Five pattern arrays (`AUTH_PATTERNS`, `RATE_LIMIT_PATTERNS`, `BILLING_PATTERNS`, `MODEL_NOT_FOUND_PATTERNS`, `NETWORK_PATTERNS`).
  - `classifyProviderError(message)` returns `{code, message, retryAfterMs?, retryable}` or null.
  - `extractRetryAfterSeconds(text)` parses common "retry after N seconds" / "retry-after: 12s" / "500ms" phrasings inline; provider-specific headers are still parsed at the HTTP layer (`lib/tools/error-codes.ts#parseRetryAfterMs`) and forwarded as `retry_after_ms` on tool errors.

* `lib/agents/llm.ts` catch block: between the existing `max_tokens` branch and the generic stack-frame fallback, calls `classifyProviderError(rawMsg)`. On match, yields the structured error chunk and returns. On no-match, falls through to the generic path (preserves today's behaviour for unrecognised errors).

* `lib/agents/run-thread.ts`:
  - `MAX_TRANSIENT_AUTO_RETRIES = 1` constant.
  - `MAX_TRANSIENT_RETRY_DELAY_MS = 60_000` cap so a misbehaving server can't pin the agent loop with a 10-minute wait.
  - `transientRetryStream(inner, originalReq, retriesLeft)` async generator. Mirrors `stallRetryStream`'s shape; recurses through `prepareThreadRun` with `_transient_retries_left = retriesLeft - 1`.
  - Wired in `prepareThreadRun` return: `stallRetryStream(transientRetryStream(rawStream, ...), ...)`. Transient retry runs first so a successful retry produces a clean turn for the stall logic to evaluate.

* `lib/agents/prepare/request.ts`: `ThreadRunRequest` gains `_transient_retries_left?: number`.

* The agent's system-prompt playbook (ADR-0049) already names `auth_error`, `rate_limit`, `billing_error`, `network_error` in the tool-error context. The same codes now appear on provider errors, so the model treats them consistently — except the agent doesn't act on provider-level errors directly (those terminate the turn before the agent gets the next prompt). The codes are primarily for the chat UI (PR-D) and the structured run-log telemetry.

## Cross-references

ADR-0049 (`error_code` first-class field — same vocabulary), ADR-0050 (tool error vocabulary — same code namespace), PR-2 (warm-summary retry — same pattern, different layer).
