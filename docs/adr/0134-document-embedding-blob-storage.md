# ADR-0134: Store document embeddings as float32 BLOBs

Status: **Accepted**

Date: 2026-11-26

Related: [ADR-0024](./0024-document-rag.md) (document RAG schema and search),
[ADR-0133](./0133-document-index-lifecycle.md) (index lifecycle and space
reclamation), [ADR-0124](./0124-sqlite-connection-pragmas.md) (SQLite profile).

## Context

`document_chunks.embedding` stored `JSON.stringify(vector)` in a TEXT column.
On the reported install that was 244,590 vectors totaling 1,955,566,660
characters (average 7,996 characters per 384-dimension vector); a float32
vector of that dimension is 1,536 bytes. The column accounted for roughly 60%
of a 3.0 GiB database, and `searchDocuments` paid `JSON.parse` on every scored
row (up to 20,000 rows per query) inside a blocking callback.

The source vectors are already float32 from the providers, so the extra decimal
text carries no additional precision. SQLite's TEXT affinity stores BLOB values
as BLOBs unchanged, so the column does not need a schema change.

## Decision

1. **New writes use float32 BLOBs.** `lib/documents/embedding-codec.ts` encodes
   vectors as little-endian float32 (`4 × dimension` bytes) and decodes both
   BLOBs and the legacy JSON text. The indexer/backfill write path uses the
   codec; search and the topic-exclusion path decode through it.
2. **Existing rows remain readable.** Search decodes either format, so no
   downtime or full-table rewrite is required to deploy.
3. **Conversion is an explicit, resumable maintenance action.** The lifecycle
   worker rewrites legacy text rows in bounded batches (`typeof(embedding) =
   'text'`, keyset by chunk id) on the dedicated writer worker, with the same
   status/ polling as the other index actions. It is deliberately not run at
   boot: rewriting ~2 GB would block startup for minutes and grows the WAL.
   The update is guarded with `typeof(embedding) = 'text'`, so a concurrent
   re-embed cannot be overwritten with an older vector.
4. **Reclaiming the file** uses the existing ADR-0133 path. Incremental
   auto-vacuum returns freed pages on databases that have it; an existing
   `auto_vacuum = 0` database still needs the explicit compaction action.
5. **Downgrades are forward-only.** An older build reading a BLOB attempts
   `JSON.parse` on it, treats it as a dimension mismatch, clears the embeddings
   for that document, and re-embeds them as JSON text. Upgrading and then
   downgrading is safe but expensive; there is no down-conversion action.

## Consequences

- On the reported install the rewrite reduces about 1.96 GB of embedding text
  to about 376 MB, before page-level overhead. Search also avoids parsing
  megabytes of JSON per query.
- Vectors are quantized to float32. They already were; decoding a legacy JSON
  vector and re-encoding it loses nothing the provider supplied.
- A partial rewrite is safe: search handles both formats, and re-running the
  action continues with the remaining text rows.
- The rewrite writes a bounded batch per transaction and yields the writer
  between batches, so interactive writes are not locked out for the whole run.
- `memory_store.embedding` and chat embeddings still use their existing format;
  this decision is scoped to document chunks.

## Alternatives considered

- **Base64 TEXT.** Saves ~74% instead of ~81% and keeps JSON-ish parsing cost.
  Rejected; BLOB needs no schema change and is simpler.
- **`sqlite-vec` / a separate vector index.** Larger architectural change that
  also removes the scan cap (ADR-0024's deferred option). Not required to fix
  the storage-format waste; revisit separately.
- **Automatic conversion in a versioned migration.** Rejected: boot migrations
  are bounded and transactional (ADR-0117), and this rewrite is neither.
- **Rewrite lazily during search.** Search reads on the read pool; adding
  writes there would couple read latency to migration progress and contend with
  the writer.
- **Keep JSON and compress it.** Loses random vector access, adds CPU per row,
  and still needs a format change.

## Validation

- `lib/documents/embedding-codec.test.ts` covers round-tripping, legacy JSON,
  malformed inputs, and non-finite components.
- `lib/documents/indexer.test.ts` asserts new writes are BLOBs and decode to
  the expected vectors; `lib/documents/search.test.ts` scores BLOB and legacy
  JSON rows identically.
- `lib/documents/lifecycle.test.ts` covers the resumable rewrite, storage-type
  conversion, byte delta, and idempotency.
- The live measurements in Context were reproduced read-only against the
  reported database before implementing.
