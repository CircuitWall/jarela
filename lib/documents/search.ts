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
import { embedQueryOne, embedQueryWithSignature, cosine } from "@/lib/embeddings";
import { getDocumentRecallPolicy, isLocalEmbeddingsEnabled } from "@/lib/stores/app-settings";
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

interface Row {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  embedding: string | null;
  embedding_model_signature: string | null;
  source_id: string;
  source_label: string | null;
  rel_path: string;
  abs_path: string;
}

export async function searchDocuments(
  query: string,
  opts?: { limit?: number; sourceId?: string; minSimilarity?: number; includeExcluded?: boolean },
): Promise<DocumentHit[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 8, 1), 25);
  const db = getDb();
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  // Hard cap on rows scanned per query — at thousands of chunks the JS
  // cosine pass is still milliseconds, but we still want a ceiling.
  const limitRows = 20_000;
  const sourceFilter = opts?.sourceId
    ? { sql: " AND d.source_id = ?", params: [opts.sourceId, limitRows] }
    : { sql: "", params: [limitRows] };
  const rows = db.prepare(
    `SELECT dc.id AS chunk_id, dc.document_id, dc.chunk_index, dc.text, dc.embedding, dc.embedding_model_signature,
            d.source_id, ds.label AS source_label, d.rel_path, d.path AS abs_path
     FROM document_chunks dc
     JOIN documents d ON dc.document_id = d.id
     JOIN document_sources ds ON d.source_id = ds.id
     WHERE ds.enabled = 1${sourceFilter.sql}
     LIMIT ?`,
  ).all(...sourceFilter.params) as unknown as Row[];

  if (rows.length === 0) return [];

  const policy = getDocumentRecallPolicy();
  const candidates = rows.map((row) => ({
    row,
    excluded: policy.excluded_documents.some(
      (d) => d.source_id === row.source_id && d.path === row.abs_path,
    ),
  })).filter(({ excluded }) => opts?.includeExcluded || !excluded);
  if (candidates.length === 0) return [];
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
      let vec: number[] | null = null;
      try { vec = JSON.parse(r.embedding) as number[]; } catch { vec = null; }
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

  function validVector(value: number[] | null): value is number[] {
    return value !== null && value.length > 0 && value.every(Number.isFinite) && value.some((n) => n !== 0);
  }

  function parseVector(value: string | null): number[] | null {
    if (!value) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) && parsed.every((n) => typeof n === "number") && validVector(parsed) ? parsed : null;
    } catch {
      return null;
    }
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
  return scored.slice(0, limit);
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
