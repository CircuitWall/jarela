# ADR-0065: Image attachments as disk refs, not base64 in message rows

- Status: Accepted
- Date: 2026-08-02

## Context

Chat threads that included images grew catastrophically. A specific
diagnostic case (thread `fb35423b-…`) accumulated **733 messages / 22 MB
of user content** — almost all base64-encoded WhatsApp bridge images
inlined directly into `messages.content`. The LangGraph checkpoint store
(`checkpoints.db`) held **238 checkpoints for that one thread totalling
893 MB**, because every retry replayed the same ~1.2 MB base64
`HumanMessage`.

Symptoms observed downstream:

- Every failing turn resurfaced the same giant HumanMessage, blowing past
  the model's context window and returning HTTP 400 from Gemini.
- Warm-summary rehydration read the entire base64 payload back into
  memory to `JSON.parse` it before emitting `[image attachment: …]`,
  costing hundreds of MB of transient RSS per summary.
- On-disk footprint compounded across `jarela.db`, `checkpoints.db`,
  and per-provider log capture.

The prior mitigation was a per-turn `checkpointer.deleteThread(threadId)`
call in `lib/agents/llm.ts` — wiping all checkpoint state before every
new turn. That papered over the growth rate but did not remove the
underlying cause: **`messages.content` was storing binary payloads
directly instead of pointers**.

## Decision

Introduce a fourth `ContentPart` variant:

```ts
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string }              // legacy inline
  | { type: "image_ref"; media_type: string; name: string;           // NEW
      sha256?: string; width?: number; height?: number; size?: number }
  | { type: "file"; name: string; media_type: string; data: string };
```

The `image` variant stays for backward compatibility with tool outputs
and for the incoming HTTP request body (client is not required to
pre-upload). Any code path that persists a message row runs the array
through `spillImageAttachments` first:

1. `Buffer.from(data, "base64")` → compute `sha256`.
2. Write to `<dataDir>/files/<sha256>.<ext>` (`sharp`-friendly, content-
   addressed → automatic dedup across messages and threads).
3. Replace the `image` part with an `image_ref` pointing at `<name>`.

The public file server (`GET /api/v1/files/[name]`, already ETag- and
Range-capable) serves the same bytes back to the UI and to any provider
that follows external URLs.

At **LLM invocation time only**, `toBaseMessages` in `lib/agents/llm.ts`
reads the file back and re-encodes to base64 as a `data:` URL for the
provider's `image_url` block. The base64 lives on the outbound HTTP
request body — it is **never** written back to `messages`, checkpoints,
warm summaries, or logs.

Two ingest paths call the spill helper:

- `prepareThreadRun` in `lib/agents/run-thread.ts` — the single funnel
  for user turns from HTTP, bridge routing, and delegated agent turns.
- `handlePageCapture` in `lib/api/page-capture.ts` — the browser
  extension's silent-observer path persists the user message directly
  via `addMessage` before dispatching a run, so it spills separately.

A one-shot boot migration in `lib/db/migrations.ts`
(`spillLegacyImageAttachments`) rewrites existing rows in place:

- Query: `messages.content LIKE '%"type":"image"%' AND LIKE '[%'`.
- Per row: parse, spill each `image` part, replace with `image_ref`,
  `UPDATE messages SET content = ?`.
- Idempotent: rows with only refs and no `image` parts fail the LIKE
  filter and are skipped on the next boot.
- Resumable: each row is its own statement; a crash mid-migration
  leaves already-migrated rows valid and the rest to be picked up on
  the next boot.
- Fast bail-out: `COUNT(*)` returning zero skips the whole scan.

## Consequences

**Storage.** Existing 22 MB threads shrink to ~200 bytes/message once
the migration lands. Checkpoints shrink proportionally (they clone
`messages` state each tick). New identical images (e.g. a WhatsApp
sticker sent 50 times) collapse to a single on-disk file via sha256
dedup.

**Provider behaviour.** Providers still receive the same
`image_url`/`image` block shape as before because `toBaseMessages`
re-encodes. No provider adapter changes.

**Backward compat.** `image` remains a valid ContentPart type. Tool
outputs may emit inline images; the spill only runs on messages that
travel through `prepareThreadRun` or `handlePageCapture`. UI renders
both variants (`ClickableImage` accepts either a `data:` URL or a
`/api/v1/files/[name]` URL). Redaction (`lib/redaction/mask-messages.ts`)
passes non-text parts through unchanged, so `image_ref` needs no
special handling there.

**Checkpoint delete hack.** `checkpointer.deleteThread` in `llm.ts`
stays for now. It was preventing a broader class of state accumulation
(tool-call bundles, not just images); the image-blowup was the acute
symptom refs remove. A follow-up (out of scope) can replace it with a
proper per-turn checkpoint scope.

**Security.** Files are content-addressed under a name matching
`[A-Za-z0-9._-]+`. Paths are validated by `isSafeFileName` before every
read and write. `readImageRef` rejects unsafe names explicitly.

**Migration downside.** On a large install (~700 rows with images) the
migration will spill ~20 MB of blobs to disk sync-during-boot and log
progress every 100 rows. Measured cost is small relative to the
`sqlite3.exec` cost of the CREATE TABLE calls above it.

## Alternatives considered

- **Client-side upload before send.** More invasive (needs a
  multipart endpoint, InputBar rewrite), doesn't cover the bridge or
  the browser extension. Deferred to a later PR — server-side spill
  gives us the DB size win now without touching the client.
- **Compress base64 in-place with `sharp`.** Doesn't solve state
  replay in checkpoints; a compressed 300 KB image still gets replayed
  N times per thread and still costs a JSON.parse per warm-summary.
  Phase 2 will layer `sharp`-based shrink on top of the spill helper.
- **Delete inline images from history windows.** Silent data loss;
  breaks the "reload restores conversation" invariant.

## References

- `lib/attachments/spill.ts` — spill + read helpers, unit-tested.
- `lib/agents/llm.ts` — `toBaseMessages` async ref loader.
- `lib/agents/run-thread.ts` — ingest funnel.
- `lib/api/page-capture.ts` — browser extension ingest.
- `lib/db/migrations.ts` — `spillLegacyImageAttachments`.
- `components/chat/MessageBubble.tsx` — dual-source `ClickableImage`.
- Related: ADR-0038 (langgraph checkpointer), ADR-0018 (page-capture
  size caps).
