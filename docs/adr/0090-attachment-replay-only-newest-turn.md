---
status: "accepted"
date: 2026-10-01
deciders: Andrew Wu
---

# 0090 - Replay image/file attachment refs only for the newest turn, not every turn

## Context and Problem Statement

ADR-0065 stopped `messages.content` from storing raw base64 image blobs by
spilling them to `<dataDir>/files/` and persisting an `image_ref` pointer
instead. `toBaseMessages` (`lib/agents/llm.ts`) reads the ref back off disk
and re-encodes it to base64 "only at LLM invocation time" — but it does this
for **every** `image_ref` in the **entire** history window, on **every**
turn, with no recency cutoff. A thread that accumulates attachments over its
life (screenshots, pasted files) resends all of them, at full size, on every
single subsequent turn — the app's own token-budget estimator
(`lib/agents/context-budget.ts`) also under-counts these since it collapses
any attachment to a short placeholder string, so nothing flags the actual
outbound request growing far larger than the app believes.

A second, related gap: non-image file attachments typed as `file` (inline,
no disk ref) bypass the spill mechanism entirely — the client reads
text/code files with `FileReader.readAsText` and sends the full text inline,
uncapped, and `toBaseMessages` inlines that text on every turn it stays in
the window, same failure shape as the pre-ADR-0065 image bug. The `file_ref`
variant already existed in the `ContentPart` union (used by the pre-upload
PDF/binary path) but had no spill call for inline `file` parts and no
read-back path at all — `toBaseMessages` always rendered `file_ref` as a
placeholder, so an uploaded PDF's content was never actually seen by the
model, defeating the point of a vision/file-capable model being routed to it.

ADR-0065 considered and rejected "delete inline images from history
windows" as an alternative, citing silent data loss and breaking the
"reload restores conversation" invariant. That invariant is about the UI
and the DB row — reload always re-fetches `messages.content` from
`jarela.db`, independent of what gets sent to the LLM provider for a given
turn. This decision narrows that rejected alternative: nothing is deleted
from storage; only what's sent to the provider on a given turn changes.

## Decision Drivers

* The provider-facing payload must not keep growing unboundedly as a thread
  accumulates attachments — this is the actual mechanism behind
  context-window blowouts and runaway image-token billing.
* No data loss: every attachment must stay fully recoverable from the same
  ref it always had, for as long as it has one.
* Fix the file-attachment variant of the same bug, not just images — a text
  file dropped into a long-running thread has the identical replay-every-
  turn problem that `image_ref` already had before ADR-0065.
* Keep provider adapters untouched; the fix belongs in the single funnel
  (`toBaseMessages`) that already owns ref resolution.

## Considered Options

* **Status quo** — keep re-inlining every ref in the window every turn.
  Rejected: this is the bug.
* **Delete attachments from history once they age out of the hot window** —
  the alternative ADR-0065 already rejected. Still rejected here for the
  same reason: it's irreversible from the LLM's perspective — the model
  could never bring the content back even if the user asks it to.
* **Token-budget-aware image accounting only** (fix the estimator in
  `context-budget.ts` to charge an image's real token cost) — would make
  the problem visible and influence which turns land in the hot window, but
  does not by itself stop a hot-window turn from resending every image in
  it. Complementary, not a substitute; left as a separate follow-up.
* **Collapse every ref except the newest turn's to a placeholder, with a
  tool to re-read it on demand** — chosen.

## Decision Outcome

Chosen option: **full readout only for the newest message in the window;
every earlier occurrence of an `image_ref`/`file_ref` collapses to a text
placeholder that carries the ref's `name` + `media_type`, and a new
`view_attachment` tool lets the model re-read it on demand.**

Changes:
- `lib/attachments/spill.ts`: `spillImageAttachments` renamed to
  `spillAttachments` and extended to also spill inline `file` parts to
  `file_ref` via the existing `spillFileBuffer` (previously only wired to
  the pre-upload HTTP route, never to `prepareThreadRun`'s ingest path).
  Added `readFileRef`, mirroring `readImageRef`.
- `lib/agents/llm.ts`: `toBaseMessages` now tracks whether the message being
  converted is the last one in the window (`appendHistoryMessage` in
  `run-thread.ts` always appends the current turn last, so this is exactly
  the turn being responded to). Only for that message does `image_ref` read
  back and re-encode to base64, and does `file_ref` read back and inline
  its text (new — `file_ref` previously never got real content, regardless
  of position, because nothing called `readFileRef` from here). Every
  earlier `image_ref`/`file_ref` becomes a placeholder naming the ref.
- `lib/tools/filesystem/view-attachment.ts` (new): `view_attachment` tool.
  For a `file_ref` it returns the real text content again (same decode path
  as the newest-turn case). For an `image_ref` it can only return the file's
  `/api/v1/files/<name>` URL — every provider adapter in this codebase
  coerces a tool result to a plain string before it reaches the model (see
  `lib/providers/{anthropic,openai,gemini}.ts`, `lib/providers/langchain.ts`),
  so there is no path today for a tool result to carry a vision block back
  into context. The tool's response says this explicitly rather than letting
  the model assume it can "see" the image again.
- `lib/agents/conversation-summary.ts`: `transcriptText`'s `image_ref`/
  `file_ref` placeholders now include the ref `name`, not just
  `media_type`/`filename` — so a conversation that's aged past the hot
  window into a warm summary still carries enough information to call
  `view_attachment` on something the summary mentions.

### Consequences

* Good, because a thread's outbound provider payload no longer grows with
  every attachment it has ever accumulated — only the newest turn's
  attachments are inlined.
* Good, because file attachments get the same disk-ref treatment images
  got in ADR-0065, closing an equivalent unbounded-replay path, and gain
  working content delivery via `file_ref` for the first time (previously a
  silent gap: `file_ref` was always a placeholder, never real content).
* Good, because nothing is deleted — every ref is recoverable via
  `view_attachment` (files: full content; images: a URL) for as long as the
  file exists on disk, independent of how old the message is.
* Neutral, because `view_attachment`'s image path cannot restore the
  model's vision over an old image — only a URL. This is an honest
  reflection of a real constraint (tool results are text-only everywhere in
  this codebase), not a limitation specific to this change. A future ADR
  could revisit multimodal tool results if that gap needs closing.
* Neutral, because the token-budget estimator in `context-budget.ts` still
  under-counts attachment cost for whichever turn is newest — this ADR
  bounds the *replay* problem, not the *estimation* problem. Tracked
  separately.
* Bad, because the model must notice and act on the placeholder's call-to-
  action to recover an older attachment — if it doesn't, that attachment's
  content is simply unavailable for that turn (recoverable on request, but
  not automatic). Mitigated by making the placeholder's instruction
  explicit and literal (the exact tool-call shape to use).

## More Information

Follows a context-window risk review (2026-10-01) that also flagged
`context-budget.ts`'s image-blind token estimation (tracked separately, not
fixed by this ADR) and the previously-silent `file_ref` content gap (fixed
here as a side effect of the same change). See
`lib/agents/llm.test.ts` ("re-reads an image_ref for the newest message but
collapses an older occurrence to a placeholder", "re-reads a text file_ref
for the newest message..."), `lib/attachments/spill.test.ts`
("spillAttachments"), and `lib/tools/filesystem/view-attachment.test.ts`.
