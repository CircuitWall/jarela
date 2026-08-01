# 0067 – Discover context window on save, halve it on runtime overflow

- Status: accepted
- Date: 2026-06-24

## Context

The chat runtime trims history to fit within a per-model
`context_window_tokens` budget. When no value is stored on a model
config, it falls back to `DEFAULT_CONTEXT_WINDOW_TOKENS = 8_192` — a
deliberately paranoid floor, but too small for anything modern. Prior
compensation was two-fold:

1. A **hand-curated static table** in
   `lib/providers/known-context-windows.ts` covering the current
   generation of Anthropic / OpenAI / Gemini / DeepSeek / Copilot
   model IDs.
2. A **runtime self-correct** in `lib/agents/llm.ts` that catches
   context-overflow errors, tries to parse the provider-reported limit
   out of the error string, and persists it back via
   `upsertModelConfig` — but only when a numeric limit was extractable.

Both compensations leaked in the wild:

- The static table drifted the moment a new model shipped (e.g. Gemini
  3.6 flash/pro rolled out and immediately mapped to the 8 192 floor,
  crippling any agent using them).
- The runtime self-correct silently did nothing when the provider's
  error message didn't include a token count. Many providers say
  "context length exceeded" without a number; those users saw an
  unhelpful error and no persisted correction, so every subsequent
  turn kept failing exactly the same way.

## Decision

**Two new mechanisms, symmetric to the two failure modes.**

### 1. Save-time discovery

New helper `lib/models/discover-context-window.ts`:

```ts
export async function discoverContextWindow(
  provider: string,
  model_id: string,
  params: ProviderParams,
): Promise<number | null>
```

Priority order:

1. `getProvider(provider).listModels(params)` — live catalog fetch,
   already the source of truth for the `/api/v1/providers/[provider]/models`
   endpoint. Matches by exact id, then longest-prefix, then
   longest-substring (both directions) to handle versioned IDs
   (`gpt-4o-2024-08-06` vs the user's saved `gpt-4o`).
2. `getKnownContextLength(provider, model_id)` — the existing static
   table, unchanged.
3. `null` — caller keeps the value unset.

Wrapper `enrichParamsWithDiscoveredContext` is called from **both**
save endpoints (`POST /api/v1/models`, `PUT /api/v1/models/[name]`)
immediately before `upsertModelConfig`. It only fills in
`context_window_tokens` when the user didn't pin one explicitly, and
never throws — a flaky provider `/models` call must not block a save.

Result: every future save picks up the true window automatically. No
more hand-editing a static table each time a provider ships a new SKU.

### 2. Runtime halve-fallback

Existing self-correct in `lib/agents/llm.ts` gains an `else` branch:
when the error string doesn't yield a parseable limit, halve the
currently-stored `context_window_tokens` (or halve a mid-size
assumption of 128 000 when nothing is pinned), clamp to a 2 048
floor, and persist. The user's next turn uses the smaller value. If
it still overflows, we halve again. Convergence takes at most
`log2(assumed / 2048)` turns — for a 128 000-token starting point,
that's at most 6 turns.

Explicit non-goals:

- **No automatic retry of the failing turn.** The stream loop is
  event-driven and threaded through LangGraph's checkpointer; injecting
  a mid-flight retry needs a separate design pass. The friendly error
  message already tells the user to retry, and the corrected budget
  is guaranteed to be in effect on the next attempt.

## Consequences

- **Wins:** Users who add a brand-new model no longer see the 8 192
  fallback. Users whose provider silently sub-caps them (e.g. tier
  throttling, prompt-cache overhead the client can't see) converge to
  a working budget in ≤ 6 turns instead of an infinite loop of
  identical failures.
- **Trade-offs:** The runtime halve is coarse — a model whose real
  limit is 200 000 tokens but which overflows at 190 000 today (because
  of one large tool output) will get its window halved to 100 000 and
  stay there. This is preferable to the current "silently do nothing"
  behaviour; users who want a tighter target can pin
  `context_window_tokens` manually, which the halve branch never
  overwrites downward past their pin (it halves the current stored
  value, so a user-pinned 300 000 becomes 150 000, which is still
  larger than what the provider will actually accept — the next turn
  halves again).
- **Follow-up:** Consider surfacing the corrected value in the model
  editor UI with a "recently auto-corrected" badge so users can undo
  or re-pin.
- **Follow-up:** Consider auto-retry (bounded, once) after the persist
  step. Deferred pending a stream-orchestration review.

## Alternatives considered

- **Ship a new static-table entry every time a provider releases a
  model.** Rejected — that's what caused the outage. Discovery makes
  the whole class of bug go away.
- **Fail hard when no `context_window_tokens` is set.** Rejected —
  ergonomics regression; would break every existing model config on
  upgrade.
- **Trust the provider's advertised max as-is.** Rejected — many
  providers advertise a headline window that requires a specific tier
  or plan; the observed overflow limit is often lower. The 10 %
  safety-margin shrink (existing behaviour when a limit IS parseable)
  and the halve-fallback (new) together handle the mismatch without
  the user having to know about it.
