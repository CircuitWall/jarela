// Semantic search over document_chunks (ADR-0024). Cosine over embedded
// chunks; substring fallback for chunks without embeddings (covers the
// "no embedding provider configured" case and the brief window before
// async embed completes after indexing).
//
// When a dimension mismatch is detected (old embeddings incompatible with
// new query vector), the search falls back to substring matching and queues
// an async reindex of that document's chunks so the semantic index is
// eventually repaired (see queueDocumentReindex).

import { getDb } from "@/lib/db";
import { readAppRows } from "@/lib/db/read-pool";
import { embedQueryOne, embedQueryWithSignature, cosine } from "@/lib/embeddings";
import { getDocumentRecallPolicy, isLocalEmbeddingsEnabled } from "@/lib/stores/app-settings";
import { withBlockingWork } from "@/lib/diagnostics/event-loop";
import { decodeEmbedding, type StoredEmbedding } from "./embedding-codec";
import { DocumentExclusionUnavailableError } from "./recall-policy";

// Track documents we've already queued for reindexing this session to avoid
// repeated work. This is session-scoped; the Set resets on app restart.
const reindexQueued = new Set<string>();
export const DEFAULT_DOCUMENT_MIN_SIMILARITY = 0.86;

export function getDefaultDocumentMinSimilarity(): number {
  return isLocalEmbeddingsEnabled() ? DEFAULT_DOCUMENT_MIN_SIMILARITY : 0.25;
}

export interface DocumentHit {
  document_id: string;
  source_id: string;
  source_label: string | null;
  rel_path: string;
  abs_path: string;
  chunk_index: number;
  text: string;
  score: number;
  match: "semantic" | "substring";
  excluded?: boolean;
}

export interface DocumentSearchCoverage {
  scanned_chunks: number;
  /** Sum of the maintained `documents.chunk_count` for the searched sources. */
  total_chunks: number;
  /** True when the scan stopped at its row cap before reaching every chunk. */
  truncated: boolean;
  max_scanned_rows: number;
}

export interface DocumentSearchResult {
  hits: DocumentHit[];
  coverage: DocumentSearchCoverage;
}

interface SearchOptions {
  limit?: number;
  sourceId?: string;
  minSimilarity?: number;
  includeExcluded?: boolean;
  /** Test seam; production uses SEARCH_MAX_SCANNED_ROWS. */
  maxScannedRows?: number;
}

interface Row {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  embedding: StoredEmbedding;
  embedding_model_signature: string | null;
  source_id: string;
  source_label: string | null;
  rel_path: string;
  abs_path: string;
}

export async function searchDocuments(
  query: string,
  opts?: SearchOptions,
): Promise<DocumentHit[]> {
  return (await searchDocumentsWithMeta(query, opts)).hits;
}

/**
 * Search with coverage metadata. The scan is capped; `coverage.truncated`
 * tells callers when the cap stopped it before every candidate chunk was
 * scored, so a tool result never presents a partial scan as complete.
 */
export async function searchDocumentsWithMeta(
  query: string,
  opts?: SearchOptions,
): Promise<DocumentSearchResult> {
  const limit = Math.min(Math.max(opts?.limit ?? 8, 1), 25);
  const requestedMax = opts?.maxScannedRows ?? SEARCH_MAX_SCANNED_ROWS;
  const maxScannedRows = Number.isFinite(requestedMax)
    ? Math.max(1, Math.floor(requestedMax))
    : SEARCH_MAX_SCANNED_ROWS;
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return {
      hits: [],
      coverage: { scanned_chunks: 0, total_chunks: 0, truncated: false, max_scanned_rows: maxScannedRows },
    };
  }

  const policy = getDocumentRecallPolicy();
  const topicResult = !opts?.includeExcluded && policy.topics.length > 0
    ? await embedQueryWithSignature(policy.topics)
    : null;
  const topicVectors = topicResult?.vectors ?? [];
  if (topicResult && (!topicResult.modelSignature || !topicResult.vectors
    || topicVectors.length !== policy.topics.length || topicVectors.some((v) => !validVector(v)))) {
    throw new DocumentExclusionUnavailableError();
  }
  const qVec = await embedQueryOne(trimmed);
  const scored: DocumentHit[] = [];
  const lowered = trimmed.toLowerCase();
  const minSimilarity = Math.max(0, Math.min(1, opts?.minSimilarity ?? getDefaultDocumentMinSimilarity()));
  const mismatched = new Set<string>();
  const totalChunks = await countCandidateChunks(opts?.sourceId);
  let scannedChunks = 0;

  for await (const page of readCandidatePages(opts?.sourceId, maxScannedRows)) {
    scannedChunks += page.length;
    const candidates = page.map((row) => ({
      row,
      excluded: policy.excluded_documents.some(
        (d) => d.source_id === row.source_id && d.path === row.abs_path,
      ),
    })).filter(({ excluded }) => opts?.includeExcluded || !excluded);
    if (candidates.length === 0) continue;

    withBlockingWork("documents:search-score", () => {
      for (const { row: r, excluded } of candidates) {
        if (topicVectors.length > 0) {
          const vector = parseVector(r.embedding);
          if (!vector || r.embedding_model_signature !== topicResult?.modelSignature
            || topicVectors.some((topic) => topic.length !== vector.length)) {
            throw new DocumentExclusionUnavailableError();
          }
          if (topicVectors.some((topic) => topic && cosine(topic, vector) >= policy.topic_similarity)) continue;
        }
        let score = 0;
        let match: "semantic" | "substring" = "semantic";
        if (qVec && r.embedding) {
          const vec = decodeEmbedding(r.embedding);
          if (vec && vec.length === qVec.length) {
            score = cosine(qVec, vec);
            // A weak positive semantic match must not bypass the floor via text.
            if (score > 0 && score <= minSimilarity) continue;
          } else {
            // Dimension mismatch: track this document for reindexing.
            mismatched.add(r.document_id);
          }
        }
        if (score <= 0) {
          score = substringScore(r.text, lowered);
          match = "substring";
        }
        if (score <= 0) continue;
        scored.push({
          document_id: r.document_id,
          source_id: r.source_id,
          source_label: r.source_label,
          rel_path: r.rel_path,
          abs_path: r.abs_path,
          chunk_index: r.chunk_index,
          text: r.text,
          score,
          match,
          ...(opts?.includeExcluded ? { excluded } : {}),
        });
      }
    });
  }

  // Queue mismatched documents for reindexing if we haven't already in this session.
  for (const docId of mismatched) {
    if (!reindexQueued.has(docId)) {
      reindexQueued.add(docId);
      clearEmbeddingsForDocument(docId).catch((err) => {
        console.error(
          `[search] failed to queue document ${docId} for reindexing:`,
          err,
        );
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return {
    hits: scored.slice(0, limit),
    coverage: {
      scanned_chunks: scannedChunks,
      total_chunks: totalChunks,
      truncated: scannedChunks >= maxScannedRows && scannedChunks < totalChunks,
      max_scanned_rows: maxScannedRows,
    },
  };
}

/**
 * Candidate chunk total for the same source filter, from the maintained
 * `documents.chunk_count` column. This is an index-only aggregate over
 * `documents`; counting `document_chunks` rows reads the whole multi-GB table.
 */
async function countCandidateChunks(sourceId: string | undefined): Promise<number> {
  const params: unknown[] = [];
  let where = "WHERE ds.enabled = 1";
  if (sourceId) {
    where += " AND d.source_id = ?";
    params.push(sourceId);
  }
  const rows = await readAppRows<{ total_chunks: number }>(
    `SELECT COALESCE(SUM(d.chunk_count), 0) AS total_chunks
       FROM documents d
       JOIN document_sources ds ON ds.id = d.source_id
       ${where}`,
    params,
  );
  return Number(rows[0]?.total_chunks) || 0;
}

function validVector(value: number[] | null): value is number[] {
  return value !== null && value.length > 0 && value.every(Number.isFinite) && value.some((n) => n !== 0);
}

function parseVector(value: StoredEmbedding): number[] | null {
  const vector = decodeEmbedding(value);
  return vector && validVector(vector) ? vector : null;
}

const SEARCH_PAGE_ROWS = 2_000;
// Scoring is a JS cosine over JSON-encoded vectors, so the scan stays capped.
// The cap is ordered deterministically instead of taking whatever rows the
// planner returns first: the old `LIMIT 20000` without `ORDER BY` silently
// ignored every chunk past the first 20k by rowid.
const SEARCH_MAX_SCANNED_ROWS = 20_000;

/**
 * Pages candidate chunks from the read-only worker pool, ordered by
 * (document_id, chunk_index) with keyset pagination. The write connection is
 * synchronous, so reading this corpus there froze the whole process; paging
 * also bounds peak memory to one page of embeddings at a time.
 */
async function* readCandidatePages(
  sourceId: string | undefined,
  maxScannedRows: number,
): AsyncGenerator<Row[]> {
  let scanned = 0;
  let cursor: { document_id: string; chunk_index: number } | null = null;
  while (scanned < maxScannedRows) {
    const pageSize = Math.min(SEARCH_PAGE_ROWS, maxScannedRows - scanned);
    const params: unknown[] = [];
    let where = "WHERE ds.enabled = 1";
    if (sourceId) {
      where += " AND d.source_id = ?";
      params.push(sourceId);
    }
    if (cursor) {
      where += " AND (dc.document_id, dc.chunk_index) > (?, ?)";
      params.push(cursor.document_id, cursor.chunk_index);
    }
    const page = await readAppRows<Row>(
      `SELECT dc.id AS chunk_id, dc.document_id, dc.chunk_index, dc.text, dc.embedding, dc.embedding_model_signature,
              d.source_id, ds.label AS source_label, d.rel_path, d.path AS abs_path
       FROM document_chunks dc
       JOIN documents d ON dc.document_id = d.id
       JOIN document_sources ds ON d.source_id = ds.id
       ${where}
       ORDER BY dc.document_id, dc.chunk_index
       LIMIT ?`,
      [...params, pageSize],
    );
    if (page.length === 0) return;
    scanned += page.length;
    yield page;
    const last = page[page.length - 1];
    // Guard against a non-advancing cursor (duplicate rows from a malformed
    // page) turning the scan into an endless loop.
    if (cursor && last.document_id === cursor.document_id && last.chunk_index === cursor.chunk_index) return;
    cursor = { document_id: last.document_id, chunk_index: last.chunk_index };
  }
}

function substringScore(haystack: string, needleLower: string): number {
  const hay = haystack.toLowerCase();
  if (!hay.includes(needleLower)) {
    // Try token-level OR match — at least one query token has to appear.
    const tokens = needleLower.split(/\s+/).filter((t) => t.length > 2);
    let hits = 0;
    for (const t of tokens) if (hay.includes(t)) hits++;
    if (hits === 0) return 0;
    return Math.min(0.4, hits / Math.max(tokens.length, 1) * 0.4);
  }
  // Phrase match — high but below typical semantic top scores.
  return 0.6;
}

/**
 * Clear embeddings for a document's chunks so they can be re-embedded.
 * Called when a dimension mismatch is detected during search.
 * Fire-and-forget: the next scheduler tick's indexAllSources() will
 * re-embed these chunks via backfillDocumentEmbeddings().
 */
async function clearEmbeddingsForDocument(documentId: string): Promise<void> {
  const db = getDb();
  const count = db
    .prepare("UPDATE document_chunks SET embedding=NULL WHERE document_id=?")
    .run(documentId).changes;
  if (count > 0) {
    console.log(
      `[search] detected embedding dimension mismatch; cleared ${count} chunks for document ${documentId}. ` +
      `Scheduler will re-embed on the next tick.`,
    );
  }
}
