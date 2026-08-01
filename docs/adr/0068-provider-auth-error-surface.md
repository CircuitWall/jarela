# 0068 – Provider auth errors surface as an actionable UI banner

- Status: accepted
- Date: 2026-08-01

## Context

When a model's credential was rejected mid-turn, the failure was
invisible or misdirected:

- **Gemini's adapter transparently fell back** from the native REST
  endpoint to the OpenAI-compat endpoint on any thrown error, including
  auth failures. Both endpoints use the SAME `api_key`, so the fallback
  wasted a round-trip AND masked the real cause behind the compat
  endpoint's less specific `400 no body`.
- **The chat runtime bucketed the failure into `agent_error`** — the
  UI showed a generic red toast with the raw provider error message,
  and the user had no way to know that the fix was "re-enter the
  credential in Settings → Credentials".
- **The daily health probes DO already classify auth failures** for
  every configured integration (`lib/health/probes.ts` returns
  `status: "auth_failed"`), but those only fire on the scheduled cycle;
  a live chat turn produced no `auth_failed` signal, so the user got
  no immediate feedback.

## Decision

**Two symmetric surfaces, matching the two failure modes:**

### 1. Typed exception at the provider boundary

New `lib/providers/errors.ts`:

- `ProviderAuthError extends Error` — carries `provider`, `status`, and
  `code = "auth_failed"`. Thrown at every Gemini native fetch site
  when the HTTP status is 401/403 or the body matches
  `API_KEY_INVALID`.
- `isAuthHttpStatus(status)` — narrow check (401, 403 only). 429 is
  deliberately excluded; that's a throttling problem, not an auth
  problem.
- `isAuthErrorMessage(msg)` — provider-agnostic heuristic over the
  error string. Kept conservative so it can't misclassify context
  overflow or throttling errors as auth. Used by the chat runtime
  because some providers return plain `Error("…")` strings that never
  see a `ProviderAuthError` instance.

Gemini's `chat`/`invoke`/`streamInvoke` catch blocks check
`err instanceof ProviderAuthError` and **re-throw** instead of falling
back to compat. Since both endpoints share the credential, the
fallback provably can't succeed, and re-throwing preserves the
targeted error class for the runtime.

### 2. Structured runtime error → typed SSE chunk → deep-link banner

In `lib/agents/llm.ts`, the run-catch block now:

- Detects `err instanceof ProviderAuthError` OR
  `isAuthErrorMessage(rawMsg)`.
- Sets `code = "auth_failed"`.
- Emits an SSE `error` chunk with `credential_id` (from the model
  config) and `provider` in the payload.

`SSEEventType.error` in `api/types.ts` gains optional `credential_id`
and `provider` fields.

`useSSE` exposes a structured `authError = { message, credential_id?,
provider? }` alongside the existing string `error`, cleared on
`start()`/`attach()`.

New `components/chat/AuthErrorBanner.tsx` renders above the input:

- Red bordered card, in-flow (not a toast), so the user can see it
  while composing.
- A "Fix {provider} credential" button linking to
  `/settings/credentials?edit=<credential_id>` — or just
  `/settings/credentials` when no id was surfaced.
- Dismiss button (X) that clears the banner locally without hiding the
  underlying error state.

`useChatErrorReporting` suppresses the generic error toast when the
banner is already carrying the same message, so the user doesn't see
both.

## Consequences

- **Wins:** The user's next action after an auth failure is one click
  away instead of "read the raw error → mentally map provider name to
  integration name → navigate to the right settings tab → find the
  right row". Gemini no longer wastes a round-trip on the compat
  fallback when the failure is provably shared between endpoints.
- **Trade-off:** `ProviderAuthError` is only thrown by Gemini today.
  Other providers rely on the runtime message-classifier. Adding
  explicit `throw new ProviderAuthError` sites to OpenAI / Anthropic /
  DeepSeek / Copilot is a per-provider follow-up — the runtime already
  routes them through `isAuthErrorMessage`, so the UX is the same; only
  the `provider` field on the banner would be more reliably populated.
- **Trade-off:** No live update to the health-probe registry. The
  daily probe (Phase 6) will catch the same failure and mark the
  integration unhealthy in `/settings/credentials`. A live "mark
  unhealthy right now" hook would need a credential_id → probe_name
  map that doesn't exist yet; scoped out to keep the PR focused.

## Alternatives considered

- **A modal dialog on auth failure.** Rejected — the user might be
  mid-composition; modals steal focus and lose typed input on some
  browsers.
- **Automatic credential re-probe on the runtime signal.** Rejected —
  it would race the daily probe cycle and there's no cheap "just check
  this one key" primitive that doesn't require adding a probe-per-
  credential index. Deferred to Phase 6.
- **Attempt an automatic retry after the user re-saves the credential.**
  Rejected — the user is already best-positioned to decide when to
  retry (they may want to trim history, switch models, etc.). The
  banner disappears on the next successful stream event so it doesn't
  linger after a fix.
