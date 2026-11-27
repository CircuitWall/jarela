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
  content_hash: string | null;
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
  const contentHashes = new Map<string, string | null>();
  const sources = await listCandidateSources(opts?.sourceId);
  const totalChunks = sources.reduce((sum, source) => sum + source.chunks, 0);
  const allocations = allocateScanBudget(sources, maxScannedRows);
  let scannedChunks = 0;

  for await (const page of readCandidatePagesAcrossSources(sources, allocations)) {
    scannedChunks += page.length;
    for (const row of page) contentHashes.set(row.document_id, row.content_hash);
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
  const seen = new Set<string>();
  const hits: DocumentHit[] = [];
  for (const hit of scored) {
    const hash = contentHashes.get(hit.document_id);
    const identity = `${hash && hash.length > 0 ? hash : hit.document_id}:${hit.chunk_index}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    hits.push(hit);
  }
  return {
    hits: hits.slice(0, limit),
    coverage: {
      scanned_chunks: scannedChunks,
      total_chunks: totalChunks,
      truncated: scannedChunks >= maxScannedRows && scannedChunks < totalChunks,
      max_scanned_rows: maxScannedRows,
    },
  };
}

export interface CandidateSource {
  source_id: string;
  chunks: number;
}

/**
 * Enabled sources and their maintained chunk counts. This is an index-only
 * aggregate over `documents`; counting `document_chunks` rows reads the whole
 * multi-GB table.
 */
async function listCandidateSources(sourceId: string | undefined): Promise<CandidateSource[]> {
  const params: unknown[] = [];
  let where = "WHERE ds.enabled = 1";
  if (sourceId) {
    where += " AND d.source_id = ?";
    params.push(sourceId);
  }
  const rows = await readAppRows<{ source_id: string; chunks: number | string }>(
    `SELECT d.source_id, COALESCE(SUM(d.chunk_count), 0) AS chunks
       FROM documents d
       JOIN document_sources ds ON ds.id = d.source_id
       ${where}
       GROUP BY d.source_id
       ORDER BY d.source_id`,
    params,
  );
  return rows
    .map((row) => ({ source_id: row.source_id, chunks: Number(row.chunks) || 0 }))
    .filter((source) => source.chunks > 0);
}

/**
 * Split a capped scan budget across enabled sources so one large source cannot
 * starve the others. The split is proportional to each source's maintained
 * chunk count and capped at that source's total; unused budget is redistributed
 * until the budget or the sources are exhausted.
 */
export function allocateScanBudget(
  sources: readonly CandidateSource[],
  budget: number,
): Map<string, number> {
  const allocations = new Map<string, number>();
  const pending = sources
    .filter((source) => source.chunks > 0)
    .map((source) => ({ id: source.source_id, remaining: source.chunks }));
  let left = Math.max(0, Math.floor(budget));

  while (left > 0 && pending.length > 0) {
    const totalRemaining = pending.reduce((sum, source) => sum + source.remaining, 0);
    if (totalRemaining === 0) break;
    let used = 0;
    for (const source of pending) {
      if (left - used <= 0) break;
      const share = Math.max(1, Math.floor((left * source.remaining) / totalRemaining));
      const take = Math.min(source.remaining, share, left - used);
      if (take <= 0) continue;
      allocations.set(source.id, (allocations.get(source.id) ?? 0) + take);
      source.remaining -= take;
      used += take;
    }
    if (used === 0) break;
    left -= used;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index].remaining === 0) pending.splice(index, 1);
    }
  }
  return allocations;
}

function validVector(value: number[] | null): value is number[] {
  return value !== null && value.length > 0 && value.every(Number.isFinite) && value.some((n) => n !== 0);
}

function parseVector(value: StoredEmbedding): number[] | null {
  const vector = decodeEmbedding(value);
  return vector && validVector(vector) ? vector : null;
}

const SEARCH_PAGE_ROWS = 2_000;
// Scoring is a JS cosine over stored vectors, so the scan stays capped. The
// budget is shared across sources by allocateScanBudget; within a source the
// order is deterministic and keyset-paged, so later chunks remain reachable.
const SEARCH_MAX_SCANNED_ROWS = 20_000;

async function* readCandidatePagesAcrossSources(
  sources: readonly CandidateSource[],
  allocations: ReadonlyMap<string, number>,
): AsyncGenerator<Row[]> {
  for (const source of sources) {
    const allocation = allocations.get(source.source_id) ?? 0;
    if (allocation <= 0) continue;
    yield* readCandidatePages(source.source_id, allocation);
  }
}

/**
 * Pages candidate chunks from one source through the read-only worker pool,
 * ordered by (document_id, chunk_index) with keyset pagination. The write
 * connection is synchronous, so reading this corpus there froze the whole
 * process; paging also bounds peak memory to one page of embeddings at a time.
 */
async function* readCandidatePages(
  sourceId: string,
  maxScannedRows: number,
): AsyncGenerator<Row[]> {
  let scanned = 0;
  let cursor: { document_id: string; chunk_index: number } | null = null;
  while (scanned < maxScannedRows) {
    const pageSize = Math.min(SEARCH_PAGE_ROWS, maxScannedRows - scanned);
    const params: unknown[] = [sourceId];
    let where = "WHERE ds.enabled = 1 AND d.source_id = ?";
    if (cursor) {
      where += " AND (dc.document_id, dc.chunk_index) > (?, ?)";
      params.push(cursor.document_id, cursor.chunk_index);
    }
    const page = await readAppRows<Row>(
      `SELECT dc.id AS chunk_id, dc.document_id, dc.chunk_index, dc.text, dc.embedding, dc.embedding_model_signature,
              d.source_id, ds.label AS source_label, d.rel_path, d.path AS abs_path, d.content_hash
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
