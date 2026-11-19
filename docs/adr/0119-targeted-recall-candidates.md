# ADR-0119: Targeted recall candidates

- **Status:** Accepted
- **Date:** 2026-11-19
- **Supersedes:** the whole-archive scan described in ADR-0024's recall section (document RAG is unaffected)

## Context

Proactive recall (`recall()` → `searchMemory()`) compared the query vector
against **every** embedded memory row and chat message held in an in-process
cache. On a live install that was 10.9k message vectors plus 1.4k memory
vectors: ~540 ms to load, ~100 MB of parsed `number[]` retained for the life of
the process, and growth proportional to total history forever.

That is untargeted retrieval. It has no scope, no candidate pruning, and no way
to answer "is this the newest information" other than by similarity. It also
made every turn pay for history that cannot plausibly be relevant.

## Decision

Recall candidates are generated per query from SQLite, on the read-only worker
pool, instead of from a process-wide vector cache.

1. **Scope.** Automatic per-turn recall considers:
   - the **current thread in full** — a long conversation never loses its own
     earlier turns to a recency cutoff, and
   - every thread inside a **30-day recency window**, newest first, capped at
     2,000 candidates.
   `memory_search` (explicit tool, panel) uses **deep** mode: newest 5,000
   candidates across all history.
2. **Full-text prefilter.** A `messages_fts` FTS5 external-content index over
   the first 2,000 characters of completed messages contributes up to 200
   lexical candidates from **any** age, unioned with the scoped candidates.
   This is what keeps old, exactly-worded material reachable without widening
   the time window.
3. **Triggers index only completed messages.** Drafts stream one `UPDATE` per
   delta; indexing them would re-tokenize the whole message on every chunk.
   The update trigger deletes the previous index row only when the old row was
   indexed (runtime-guarded `INSERT … SELECT … WHERE`), because a phantom
   delete corrupts the FTS index when a draft is deleted before completion.
4. **Memory rows stay in memory.** The memory store is small (~1.4k rows),
   already write-through-cached, and mostly encrypted at rest, so it is neither
   scoped nor full-text indexed. Its literal/keyword fallbacks remain.

## Consequences

- Recall no longer grows with the size of chat history; the cost per turn is a
  few indexed queries plus cosine over a bounded candidate set.
- Cross-thread automatic recall is limited to the recency window plus lexical
  matches. Material older than 30 days that does not share query terms is only
  reachable through `memory_search` (deep) or the archive tools. The prompt
  states this.
- The FTS index adds ~5 MB for 11k messages (external content stores no copy of
  the text) and ~0.4 s to build once during migration.
- `loadMsgEmbedCache()` survives only for the re-embedding maintenance pass,
  which genuinely needs to inspect every stored vector.
- Storing vectors as JSON text is still a cost (ADR-0118 keeps the driver
  synchronous). Moving to float32 `BLOB` plus an ANN index would remove the
  remaining JS cosine pass; that is a separate decision.

## Alternatives considered

- **sqlite-vec / ANN index.** Best query cost, but a native extension plus a
  migration that rewrites every vector — too large to bundle with a scoping
  fix.
- **Recency window only (no FTS).** Cheapest, but "what did we decide about X
  in March" stops working without a lexical escape hatch.
- **Keep the cache, add scoping at query time.** Leaves the memory retention
  (the actual regression on a long-lived install) in place.
