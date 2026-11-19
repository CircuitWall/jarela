// Cached document-source statistics.
//
// `document_sources` stats require counting a corpus that is millions of rows
// wide in real installs (244k chunks measured on a live database). Counting it
// synchronously costs 0.3–2.2s per source — and the system prompt asked for
// those counts on every single agent turn, so each turn froze the whole
// process for ~3s (node:sqlite is synchronous).
//
// The counts are only advertising ("you have N indexed chunks"), so they are
// computed on the read-only worker pool and served from memory. Nobody blocks
// on them: the prompt reads the snapshot, the HTTP route refreshes it first.

import { readAppRows } from "@/lib/db/read-pool";
import { getOrCreateGlobal } from "@/lib/utils/global-state";
import type { DocumentSourceStats } from "@/api/document-sources";

const SOURCE_STATS_QUERY = `
  SELECT s.id AS source_id,
         COUNT(DISTINCT d.id) AS document_count,
         COUNT(c.id) AS chunk_count,
         COUNT(c.embedding) AS embedded_chunk_count
  FROM document_sources s
  LEFT JOIN documents d ON d.source_id = s.id
  LEFT JOIN document_chunks c ON c.document_id = d.id
  GROUP BY s.id`;

interface StatsSnapshot {
  computed_at: number | null;
  by_source: Map<string, DocumentSourceStats>;
  refreshing: Promise<void> | null;
}

function snapshot(): StatsSnapshot {
  return getOrCreateGlobal<StatsSnapshot>("__jarela_document_source_stats", () => ({
    computed_at: null,
    by_source: new Map(),
    refreshing: null,
  }));
}

function emptyStats(sourceId: string): DocumentSourceStats {
  return { source_id: sourceId, document_count: 0, chunk_count: 0, embedded_chunk_count: 0 };
}

interface StatsRow {
  source_id: string;
  document_count: number;
  chunk_count: number;
  embedded_chunk_count: number;
}

/**
 * Recompute every source's counters on the read pool. Concurrent callers share
 * one in-flight refresh. Errors leave the previous snapshot in place.
 */
export function refreshDocumentSourceStats(): Promise<void> {
  const state = snapshot();
  if (state.refreshing) return state.refreshing;
  state.refreshing = (async () => {
    try {
      const rows = await readAppRows<StatsRow>(SOURCE_STATS_QUERY);
      const next = new Map<string, DocumentSourceStats>();
      for (const row of rows) {
        next.set(row.source_id, {
          source_id: row.source_id,
          document_count: Number(row.document_count) || 0,
          chunk_count: Number(row.chunk_count) || 0,
          embedded_chunk_count: Number(row.embedded_chunk_count) || 0,
        });
      }
      state.by_source = next;
      state.computed_at = Date.now();
    } catch (error) {
      console.warn("[documents] source stats refresh failed:", error);
      throw error;
    } finally {
      state.refreshing = null;
    }
  })();
  return state.refreshing;
}

/** Cached counters for one source, or null before the first refresh. */
export function cachedDocumentSourceStats(sourceId: string): DocumentSourceStats | null {
  return snapshot().by_source.get(sourceId) ?? null;
}

/** Cached counters for every source, keyed by source id. */
export function cachedDocumentSourceStatsMap(): ReadonlyMap<string, DocumentSourceStats> {
  return snapshot().by_source;
}

/** Milliseconds since the snapshot was computed, or null before the first one. */
export function documentSourceStatsAgeMs(): number | null {
  const computed = snapshot().computed_at;
  return computed === null ? null : Date.now() - computed;
}

/** Async, authoritative read for HTTP handlers: refresh, then return. */
export async function documentSourceStatsAsync(sourceId: string): Promise<DocumentSourceStats> {
  await refreshQuietly();
  return cachedDocumentSourceStats(sourceId) ?? emptyStats(sourceId);
}

/**
 * Refresh for request paths that must not fail on a pool error: a stale
 * snapshot (or zeros) is better than a 500 on the sources page.
 */
export async function refreshQuietly(): Promise<void> {
  try {
    await refreshDocumentSourceStats();
  } catch {
    /* keep the previous snapshot */
  }
}

/** Test seam. */
export function __resetDocumentSourceStatsForTests(): void {
  const state = snapshot();
  state.by_source = new Map();
  state.computed_at = null;
  state.refreshing = null;
}
