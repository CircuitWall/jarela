---
status: accepted
date: 2026-06-02
deciders: andwu, claude
---

# Chat error card — code-aware affordances on top of the unified error vocabulary

## Context and Problem Statement

Across PRs 0049–0053 the system grew a coherent error vocabulary: tools surface `{error_code, error_message}` on `tool_result` chunks, providers classify failures into stable codes (`auth_error` / `rate_limit` / `network_error` / `billing_error` / `model_not_found`), the API client throws `ApiRequestError` with `kind: "network" | "http" | "timeout"`, and the REST envelope can carry an optional `code`.

The chat UI hadn't caught up. `ChatView` rendered the live-stream error as a `<pre>` dump in a red box:

```
<div className="mx-4 mb-2 px-3 py-2 rounded bg-red-900/40 border border-red-700">
  <pre className="whitespace-pre-wrap break-all font-mono">{error}</pre>
</div>
```

`useSSE`'s error state was `string | null` — the `code` from the upstream `error` chunk was thrown away on assignment. Users got a wall of provider stack-trace text with no Retry button, no "open settings" link for credential failures, no copy affordance, no dismiss. Sticky errors piled up across long sessions; transient blips that would have succeeded on retry were treated identically to permanent auth failures.

`ToolList`'s `isErrorPayload()` heuristic looked for `"error"` substring or a `.error` key. The ADR-0049 envelope (`{kind: "error", code, message}`) and the new `error_code` field on `tool_result` chunks weren't consulted, so the rose dot still rendered correctly but the pill couldn't surface code-specific summary text.

## Decision Drivers

* **The vocabulary already exists.** This PR consumes it; it doesn't define new codes.
* **Code → action mapping should live in one place.** The chat UI's recipe table maps every code to a friendly title + recovery hint + button set. A new code added at the server adds one entry here.
* **Don't break existing readers.** `error?.message` keeps working; new branches read `error.code`.
* **Retry should be opt-in per code.** Auth/billing/model-not-found are not retryable (replaying won't help); network/rate-limit/transient/empty-response are. The recipe encodes this so the UI doesn't show a button that would just reproduce the error.
* **Tool-level errors should benefit too.** PR-A added `error_code` / `error_message` to `tool_result` chunks; the chat UI should surface that on the per-tool pill.

## Considered Options

* **(A) Inline switch inside ChatView's render.** Keeps everything in one file but bloats ChatView further (already on the bloat-audit list).
* **(B) Standalone `ErrorCard` component with a recipe table.** One source of truth for code→action; trivially testable in isolation.
* **(C) Toast-only — push every error to the global toast tray, no in-chat banner.** Loses persistence; users miss failures while looking at another panel.

## Decision Outcome

Chosen: **(B) Standalone `ErrorCard` component**.

`components/chat/ErrorCard.tsx` exports a typed `Props { message, code, onRetry?, onDismiss? }` and looks up the code in a `CODE_RECIPES` table. Each recipe has:

- `title` — bolded headline ("Network failure", "Rate-limited by the provider", …)
- `hint` — second-line recovery copy
- `retryable` — gates the Retry button
- `settingsHref` + `settingsLabel` — when present, renders an "Open Settings" link

Codes not in the table fall through to a generic recipe (`"Run failed"`, retryable). The card always renders Copy (clipboard) and an expandable Details fold-out with the raw message + code stamp.

`useSSE`'s `error` state changes from `string | null` to `{ message: string; code: string } | null`. Existing readers updated to `error?.message`. The `code` flows through from the SSE event's `code` field (already part of `SSEEventSchema` via ADR-0044).

`ToolList`'s `ToolEvent` interface gains optional `error_code` + `error_message`. `isErrorPayload()` now checks `payload.kind === "error"` first, falling back to the legacy `.error` field, falling back to the substring heuristic. The pill colour stays as today; future PR can surface code-specific text.

`ChatView` replaces the `<pre>` dump with `<ErrorCard message={error.message} code={error.code} onRetry={…} />`. Retry is bound only when there's a current input to re-submit (the user's last typed message), avoiding a button that would do nothing.

### Consequences

* Good — every code from the unified vocabulary now produces a tailored UI: the user sees what failed, what the agent already tried, and what their next action is.
* Good — auth/billing/model-not-found codes link straight to the model-config screen with a clear button label.
* Good — Retry button on transient codes lets the user replay without retyping (when the input was preserved); the agent's auto-retry handles most of these but the user-driven retry catches cases where auto-retry is disabled or already exhausted.
* Good — Copy + collapsible details preserve the raw stack for debugging without dominating the chat layout.
* Good — adding a new code = adding one entry to `CODE_RECIPES`. No render-tree changes.
* Bad — recipes are static; codes the server emits but the UI doesn't yet know about fall through to the generic recipe. Mitigated: the generic recipe is reasonable + the Details fold-out always shows the raw message.
* Bad — `error?.message` requires updating existing string-typed readers. Audit pass already done; no readers broken.

## Pros and Cons of the Options

### (B) Standalone `ErrorCard` (chosen)

* Good — testable in isolation; future codes plug into the recipe table.
* Good — keeps ChatView smaller (already flagged as a god-component in the bloat audit).
* Good — reusable; settings panels can render the same card for their own errors.

### (A) Inline switch in ChatView

* Good — no new file.
* Bad — the bloat audit already flagged ChatView's size; adding 100 lines of code → recipe mapping would worsen it.

### (C) Toast-only

* Good — declutters chat scroll.
* Bad — easy to miss; toasts auto-dismiss.

## Implementation notes

* `components/chat/ErrorCard.tsx`:
  - Recipe table covers 14 known codes (auth, billing, rate, network, model_not_found, recursion, context, max_tokens, stream_deadline, aborted, etc.) plus a generic fallback.
  - "Open Settings" links use `next/link` with hash routes (`/?settings=models`). Settings panel routing is owned elsewhere; we just pass the user there.
  - Copy button uses `navigator.clipboard` with a guard for SSR / older browsers. Failures swallow silently — Copy is a "nice to have."
  - Details `<details>` fold lets the user see the raw message without it dominating the card.

* `hooks/useSSE.ts`: `error` state is now `{ message: string; code: string } | null`. Set on the `error` event branch (with `event.code`) and the catch in `start()` (with code `client_error`). Readers updated.

* `components/chat/ToolList.tsx`: `ToolEvent` interface adds `error_code?: string` + `error_message?: string`. `isErrorPayload()` consults `payload.kind === "error"` first; falls back to legacy shapes.

* `components/chat/ChatView.tsx`:
  - Imports `ErrorCard`.
  - Replaces the `<pre>` block with `<ErrorCard message={error.message} code={error.code} onRetry={…} />`.
  - Retry is bound only when the InputBar holds the user's last text (otherwise the button does nothing).

* The card pulls action vocabulary directly from the system-prompt playbook in `lib/agents/prepare/system-prompt.ts` (ADR-0049) — same words the agent uses internally. Keeps the user/agent mental models aligned: when the agent says "auth_error means tell the user to check their API key", the user sees a card that says exactly that.

## Cross-references

ADR-0044 (StreamChunk schema — emits `code` on every error chunk), ADR-0049 / 0050 / 0051 / 0052 / 0053 (the vocabulary this card consumes).
