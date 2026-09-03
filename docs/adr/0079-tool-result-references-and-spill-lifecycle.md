---
status: "accepted"
date: 2026-09-03
deciders: example-user
consulted:
informed:
---

# Tool results use references when they are large

## Context and Problem Statement

Jarela already spills inbound image bytes to `<dataDir>/files/` and stores
`image_ref` parts in message state instead of base64 blobs. That fixed the
image checkpoint pathology described in ADR-0065, but large tool results can
still accumulate inside a single agent turn. The current LangGraph checkpoint
workaround deletes per-thread checkpoints after each turn; it does not bound
the tool messages exchanged during the current turn.

Database forensics on a real local installation showed one thread with more
than 900 million input tokens. The hot-history token count collapsed to zero
exactly when input tokens exploded, which points at intra-turn tool-result
growth rather than replayed conversation history.

Anthropic offers `clear_tool_uses_20250919`, but that is provider-specific and
the observed runaway used Gemini through the GitHub Copilot provider. Jarela
therefore needs a provider-agnostic contract at its own tool boundary.

## Decision Drivers

* Tool results must not silently truncate. The model has to know when a preview
  is partial and how to retrieve more.
* The cap has to apply to synchronous tools and `async_run` tools equally.
* Tool schemas must not gain another globally injected control field; the
  injected wrapper fields already add prompt weight to every tool.
* Files written under `<dataDir>/files/` need lifecycle management before tool
  results become a high-volume producer in that directory.
* The storage contract should remain close to MCP `ResourceLink` so future MCP
  alignment does not require another visible shape change.

## Considered Options

1. **Use Anthropic context editing only.** Rejected as the primary mechanism
   because it does not help non-Anthropic providers.
2. **Client-side compaction of tool messages.** Rejected because it is later in
   the pipeline than the bloat, and Anthropic's own SDK-side compaction is no
   longer the preferred approach.
3. **Hard truncate tool output.** Rejected because the agent would reason over
   partial data as if it were complete.
4. **Return a bounded preview plus a file reference from the wallclock wrapper.**
   Chosen.

## Decision Outcome

`wrapWithWallclock` becomes the common result-envelope boundary for every tool.
After a tool succeeds, the wrapper serializes the result. Small results pass
through unchanged. Results above `JARELA_TOOL_RESULT_MAX_BYTES` are spilled to
the existing content-addressed file store and replaced with a JSON envelope:

* `ok: true`
* `tool`
* `truncated: true`
* `bytes`
* `preview`
* `preview_bytes`
* `result_ref` with `uri`, `name`, `mimeType`, `size`, and `sha256`

The same post-processing function is used by the synchronous path and by
`async_run`; background results store the post-processed string, not the raw
unbounded payload.

The spill happens after the tool has completed and after the wallclock race has
resolved. This means hashing and writing a huge successful result can extend the
elapsed wall-clock time of the wrapper beyond `deadline_ms`. That is accepted:
discarding a completed result during spill would be worse than taking bounded
extra local I/O time. The behaviour is documented and tested.

The result cap is server-side only. The model does not receive a
`max_result_bytes` argument on every tool.

### File lifecycle

The spill directory is shared by images, uploaded files, and tool-result refs,
and files are content-addressed. Cleanup must therefore be reference-aware, not
a pure TTL delete. A mark-and-sweep job scans persisted messages for referenced
file names or hashes and deletes only unreferenced files older than the
retention window.

## Consequences

Good:

* Large tool outputs no longer grow the current provider request without bound.
* Repeated identical results dedupe through the existing sha256 file naming.
* `async_run` no longer has an unbounded in-memory result slot for huge outputs.
* The model sees an explicit partial-result contract and retrieval hint.

Bad / accepted:

* `wrapWithWallclock` is no longer a pure timeout wrapper; it owns the visible
  success envelope for oversized results.
* Large successful results may spend additional local I/O time after the
  deadline race resolves.
* Chat rendering has to tolerate tool-event payloads that contain references
  instead of full text.

Deferred:

* Anthropic `clear_tool_uses_20250919` can be enabled as a second layer after
  the provider-agnostic cap lands.
* Durable pinning of result refs is deferred until a user-visible workflow needs
  long-lived tool artifacts.