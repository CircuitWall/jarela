# 0069 – Persist `run_error` marker rows instead of ghosting failed turns

- Status: accepted
- Date: 2026-08-01

## Context

When a chat turn failed before the assistant produced any content (auth
rejection, provider outage, context overflow, unhandled exception),
`persistAssistantMessage` skipped the insert — the row would have been
empty except for the error, so the write was guarded away as noise.

Consequences:

- **The failure vanished on reload.** Opening the thread on another
  device (or after a browser refresh) showed the user's message with
  no response — the same visual as "the agent is still thinking",
  even though the turn had ended minutes ago in error.
- **No audit trail.** Operators debugging a repro couldn't see from
  the thread that the turn had errored; they had to correlate
  server-side logs by timestamp.
- **The SSE `error` chunk was the only signal**, so any client that
  wasn't attached at the moment of failure (background tab, mobile
  screen locked) missed the failure entirely.

## Decision

**Persist a synthetic `assistant` row with `category = "run_error"`**
whenever a turn ends in `terminal="error"` without producing content
or tool events.

- The row's `content` is the error message (truncated at 2 KB).
- The row's `metadata` carries `{ kind, code, credential_id?,
  provider? }` mirroring the SSE `error` payload, so the UI can render
  the same auth-failure deep-link banner (ADR-0068) directly from the
  persisted row.
- The row's `category` is `"run_error"`.

Filters:

- `getRecentMessagesWindow` (the LLM history window) adds
  `WHERE category IS NULL OR category != 'run_error'` at the SQL
  level. This is the only cost-carrying path — the run_error message
  ("400 API_KEY_INVALID") would otherwise be presented to the model
  as an assistant turn on the next request, which is both wasteful
  and semantically wrong.
- `getMessages` / `getMessagesAfter` / `getMessagesPage` (UI paths)
  do NOT filter, so the row surfaces in the transcript.
- `MessageList`'s category filter does not gate `run_error` — it's
  always visible; there's no user value in hiding failures.

UI:

- `MessageBubble` short-circuits the render for
  `category === "run_error"`: a compact rose-tinted chip with
  `AlertTriangle` icon, "Run failed", the error text, and a timestamp.
  No avatar, no bubble, no full transcript styling.

Structural plumbing:

- `CollectedRun` gains `errorCode`, `errorCredentialId`,
  `errorProvider` so the run route can mirror the SSE error payload
  onto the marker row.
- The run route calls `persistRunErrorMarker(thread_id, ...)` from
  both:
  - the "collected error with no content" branch (normal completion
    path where the LLM stream emitted an error chunk), and
  - the outer catch (stream threw before collectStream could observe
    it).

## Consequences

- **Wins:** Failed turns are now visible, auditable, and
  cross-device-synced. Reload preserves the failure. The `auth_failed`
  banner (Phase 4) now works even for users who weren't attached at
  the moment the error was emitted, because the persisted metadata
  carries `credential_id`.
- **Trade-off:** A pathological failure loop (e.g. the credential is
  invalid and the user keeps retrying) produces one marker row per
  failed turn. Bounded by the 2 KB truncation on each row; a genuine
  runaway is caught by `pruneThreadMessages` and the compaction path
  already in place for long threads.
- **Trade-off:** The marker rows currently embed via the same
  `embedOne` path as ordinary messages (`addMessage` embeds anything
  ≥ 12 chars). This adds a small amount of vector-store noise but
  `getRecentMessagesWindow` filters them, so semantic recall never
  surfaces them into an LLM turn.

## Alternatives considered

- **Store failures in a sibling table (`run_errors`).** Rejected — it
  would require the chat UI to fetch and merge two streams, and would
  break the existing "message list = one SQL query" model. Categorising
  on the existing `messages.category` column is the pattern
  `scheduled_task` / `bridge` / `page_capture` already established.
- **Persist only when a credential_id is present.** Rejected — all
  failure modes deserve an audit row, not just auth failures.
- **Persist a "run failed" placeholder in-band via the existing
  `persistAssistantMessage` path.** Rejected — the skip-empty guard
  and the stall/fabrication footers are load-bearing for the success
  path. Injecting a synthetic message through a code path that also
  runs `validateAssistantOutput` and `mergeMessageMetadata` for
  citations was cleaner as a separate call.
