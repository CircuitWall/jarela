// Semantic search over document_chunks (ADR-0024). Cosine over embedded
// chunks; substring fallback for chunks without embeddings (covers the
// "no embedding provider configured" case and the brief window before
// async embed completes after indexing).

import { getDb } from "@/lib/db";
import { embedOne, cosine } from "@/lib/embeddings";

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
}

interface Row {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  embedding: string | null;
  source_id: string;
  source_label: string | null;
  rel_path: string;
  abs_path: string;
}

export async function searchDocuments(
  query: string,
  opts?: { limit?: number; sourceId?: string },
): Promise<DocumentHit[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 8, 1), 25);
  const db = getDb();
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  // Hard cap on rows scanned per query — at thousands of chunks the JS
  // cosine pass is still milliseconds, but we still want a ceiling.
  const limitRows = 20_000;
  const rows = (
    opts?.sourceId
      ? db.prepare(
          `SELECT dc.id AS chunk_id, dc.document_id, dc.chunk_index, dc.text, dc.embedding,
                  d.source_id, ds.label AS source_label, d.rel_path, d.path AS abs_path
           FROM document_chunks dc
           JOIN documents d ON dc.document_id = d.id
           JOIN document_sources ds ON d.source_id = ds.id
           WHERE d.source_id = ? AND ds.enabled = 1
           LIMIT ?`,
        ).all(opts.sourceId, limitRows)
      : db.prepare(
          `SELECT dc.id AS chunk_id, dc.document_id, dc.chunk_index, dc.text, dc.embedding,
                  d.source_id, ds.label AS source_label, d.rel_path, d.path AS abs_path
           FROM document_chunks dc
           JOIN documents d ON dc.document_id = d.id
           JOIN document_sources ds ON d.source_id = ds.id
           WHERE ds.enabled = 1
           LIMIT ?`,
        ).all(limitRows)
  ) as unknown as Row[];

  if (rows.length === 0) return [];

  const qVec = await embedOne(trimmed);
  const scored: DocumentHit[] = [];
  const lowered = trimmed.toLowerCase();

  for (const r of rows) {
    let score = 0;
    let match: "semantic" | "substring" = "semantic";
    if (qVec && r.embedding) {
      let vec: number[] | null = null;
      try { vec = JSON.parse(r.embedding) as number[]; } catch { vec = null; }
      if (vec) score = cosine(qVec, vec);
      else { score = substringScore(r.text, lowered); match = "substring"; }
    } else {
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
    });
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
