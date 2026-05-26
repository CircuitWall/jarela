// Shared upsert path for remote document sources (ADR-0026).
//
// Remote sources (Jira issues, Confluence pages) don't have an mtime or a
// stable filesystem path — the upstream `updated` timestamp plays the same
// role as mtime, and we synthesize a stable `path` per item (`jira://KEY`
// or `confluence://pageId`). The rest of the indexed shape matches local
// folder documents so retrieval through searchDocuments works unchanged.

import { randomUUID, createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { embed } from "@/lib/embeddings";
import { chunkText } from "../chunker";

export interface RemoteDocInput {
  /** Stable synthetic path, e.g. "jira://ABC-123" or "confluence://12345". */
  path: string;
  /** Human-readable title shown in retrieval results (Jira key+summary,
   *  Confluence page title). Stored in `rel_path` so the existing search
   *  UI shows it without schema changes. */
  title: string;
  /** ISO timestamp of the upstream `updated` field. Drives change detection
   *  via the same column the local indexer uses for filesystem mtime
   *  (re-purposed: we hash this string into mtime_ms). */
  externalUpdatedAt: string;
  /** Plain-text body to chunk + embed. Already flattened (ADF→text,
   *  HTML→text) by the caller. */
  text: string;
}

interface IndexedRow {
  id: string;
  mtime_ms: number;
  content_hash: string;
}

function findExisting(sourceId: string, path: string): IndexedRow | null {
  const row = getDb()
    .prepare("SELECT id, mtime_ms, content_hash FROM documents WHERE source_id=? AND path=?")
    .get(sourceId, path) as IndexedRow | undefined;
  return row ?? null;
}

// Map an ISO string to a stable integer so we can store it in the existing
// `mtime_ms` column without a schema change. Hashing keeps the column
// useful for "did the upstream record change?" checks even though ms
// resolution is meaningless for remote sources.
function isoToMtime(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isFinite(t)) return t;
  // Fall back to a deterministic hash so duplicate calls with the same
  // string still produce the same value.
  const h = createHash("sha1").update(iso).digest();
  return h.readUInt32BE(0);
}

function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface UpsertResult {
  status: "unchanged" | "added" | "updated";
}

/**
 * Insert-or-update a single remote document. Returns whether anything
 * actually changed so the caller can update incremental-sync counters.
 * Re-chunks + re-embeds when content changed; otherwise just touches
 * the indexed-at timestamp.
 */
export async function upsertRemoteDocument(
  sourceId: string,
  input: RemoteDocInput,
): Promise<UpsertResult> {
  const db = getDb();
  const t = new Date().toISOString();
  const hash = hashContent(input.text);
  const mtime = isoToMtime(input.externalUpdatedAt);
  const existing = findExisting(sourceId, input.path);

  if (existing && existing.content_hash === hash) {
    db.prepare("UPDATE documents SET mtime_ms=?, last_indexed_at=? WHERE id=?")
      .run(mtime, t, existing.id);
    return { status: "unchanged" };
  }

  const docId = existing?.id ?? randomUUID();
  const size = Buffer.byteLength(input.text, "utf8");

  if (existing) {
    db.prepare(
      `UPDATE documents
       SET path=?, rel_path=?, mtime_ms=?, size_bytes=?, content_hash=?, last_indexed_at=?
       WHERE id=?`,
    ).run(input.path, input.title, mtime, size, hash, t, existing.id);
    db.prepare("DELETE FROM document_chunks WHERE document_id=?").run(existing.id);
  } else {
    db.prepare(
      `INSERT INTO documents
       (id, source_id, path, rel_path, mtime_ms, size_bytes, content_hash, last_indexed_at, chunk_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(docId, sourceId, input.path, input.title, mtime, size, hash, t);
  }

  const chunks = chunkText(input.text);
  if (chunks.length === 0) {
    db.prepare("UPDATE documents SET chunk_count=0 WHERE id=?").run(docId);
    return { status: existing ? "updated" : "added" };
  }

  const insertChunk = db.prepare(
    `INSERT INTO document_chunks
     (id, document_id, chunk_index, text, start_offset, end_offset, embedding)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  );
  const chunkIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const id = randomUUID();
    chunkIds.push(id);
    insertChunk.run(id, docId, i, chunks[i].text, chunks[i].start_offset, chunks[i].end_offset);
  }
  db.prepare("UPDATE documents SET chunk_count=? WHERE id=?").run(chunks.length, docId);

  // Best-effort embed; substring fallback covers no-provider / failure cases.
  try {
    const vectors = await embed(chunks.map((c) => c.text));
    if (vectors) {
      const updateEmb = db.prepare("UPDATE document_chunks SET embedding=? WHERE id=?");
      for (let i = 0; i < vectors.length; i++) {
        updateEmb.run(JSON.stringify(vectors[i]), chunkIds[i]);
      }
    }
  } catch (err) {
    console.warn(
      "[documents/remote] embed failed for",
      input.path,
      err instanceof Error ? err.message : String(err),
    );
  }

  return { status: existing ? "updated" : "added" };
}

/**
 * Drop every indexed document for `sourceId` whose `path` isn't in the
 * keep-set. Returns the count removed. Remote indexers use this only for
 * "full re-sync" semantics — incremental syncs don't call it (an upstream
 * item disappearing doesn't necessarily mean it should be evicted; we'd
 * rather keep stale-but-useful content than punch holes silently).
 */
export function evictMissing(sourceId: string, keepPaths: Set<string>): number {
  const db = getDb();
  const rows = db.prepare("SELECT id, path FROM documents WHERE source_id=?")
    .all(sourceId) as Array<{ id: string; path: string }>;
  let removed = 0;
  const del = db.prepare("DELETE FROM documents WHERE id=?");
  for (const r of rows) {
    if (!keepPaths.has(r.path)) {
      del.run(r.id);
      removed++;
    }
  }
  return removed;
}
