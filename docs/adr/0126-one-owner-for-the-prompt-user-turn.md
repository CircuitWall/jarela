# ADR-0126: One owner for the prompt's user turn

Status: **Accepted**

Date: 2026-11-20

Related: [ADR-0039](./0039-agent-run-decomposition.md) (run decomposition),
[ADR-0044](./0044-automation-channel-context.md) (context profiles),
[ADR-0089](./0089-abort-signal-reaches-provider-calls.md) (retry attempts),
[ADR-0090](./0090-attachment-replay-only-newest-turn.md) (attachment replay).

## Context

The message list sent to the provider was assembled from three places:

1. `buildHistoryWindow` returned the hot transcript — DB rows filtered by
   history scope, `transcript_status != 'in_progress'`, run-error rows, budget
   tiers and the hot-turn limit.
2. `prepareTurnContext` replaced that list with `[{ role: "user", content }]`
   when the turn's profile set `include_hot: false`.
3. `createPreparedTurn` appended a retry nudge with `appendHistoryMessage`
   (`req._history_append_message`).

Nothing asserted that the result contained the user's request. A turn could
therefore reach the provider with a system prompt and no user content, and the
run was still recorded as a success. Observed on a live install: four
consecutive turns answered "no request came through with this turn" while the
user's messages sat in `messages` with their full text, and
`message_usage.hot_tokens` was `0` for every one of them (3,583 / 3,745 on the
healthy turns immediately before). The streak began after a run failed
mid-tool-call (`transcript_status = 'failed'`, `input_tokens = 0`), and the
thread kept behaving that way afterwards.

The retry paths made this reachable by construction: a stall retry replaces
`message` with its nudge (`message: nudgeWithContext`) and sets
`_skip_persist_message: true`, so a profile without hot history prompted the
model with only the nudge, and a replayed turn with an empty `message` had no
content source at all.

## Decision

`assemblePromptMessages` ([lib/agents/prepare/prompt-messages.ts](../../lib/agents/prepare/prompt-messages.ts))
is the only place that decides the prompt's user turn. It:

- takes hot history only when the turn's profile allows it (`include_hot`);
- treats the current request as present when the window's last message is that
  user turn, and otherwise injects the request explicitly (that case is logged,
  because it means the window dropped the row);
- appends a retry nudge after the current turn instead of replacing it;
- **throws `EmptyPromptError` when the assembled list has no non-empty user
  text**, which `prepareThreadRun` surfaces as `400 empty_turn` before any
  provider call.

The request carries the current turn's content explicitly:

- `_current_turn_content` — set by retry paths that swap `message` for a nudge,
  so the original request survives every attempt.
- When that and `message` are both empty (a replayed turn whose row is already
  persisted), `resolveCurrentTurnContent` falls back to the thread's last stored
  user message (`getLastUserMessage`, one indexed lookup).
- `initializeTurn` still returns `message_required` for a public request with no
  content at all, but lets internal retry/replay turns through to the assembler.

`appendHistoryMessage` and its unit test are removed; `promptTurnText` is the
single implementation of "text of a content part list" (it replaced the
duplicate `contentText`).

## Consequences

- A turn either prompts with the user's request or fails with `empty_turn`;
  "no request came through" can no longer be a successful assistant answer.
- One assembler owns dedupe and ordering, so a retry can neither duplicate the
  persisted prompt nor drop it.
- When the hot window does not carry the current turn (in-progress row,
  budget clip, pruning), the prompt still gets it — and the log line
  `[prompt] thread=… history requested but did not carry the current turn`
  makes that visible instead of silent.
- `promptTurnText` joins multiple text parts with a newline; the previous
  helper joined with a space. Both are inputs to token estimation only.

## Validation

- `lib/agents/prepare/prompt-messages.test.ts` covers: window already carrying
  the turn, window missing it, profile without history, nudge appended after the
  request, empty content rejected, image-only content rejected, and text plus
  attachment accepted.
- `lib/agents/run-thread.auto-boundary.test.ts` covers the production shape end
  to end: a one-shot turn with `message: ""` and `_current_turn_content` prompts
  with that content; a replayed turn with no message recovers the stored request;
  a turn with neither is rejected before `streamWithConfig`.
- Retry suites (`run-thread.retry`, `run-retry`) keep passing, so nudges still
  reach the model on the attempt that needs them.
