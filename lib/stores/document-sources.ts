// CRUD for the `document_sources` table (ADR-0024). A source is a folder
// the user has asked Jarela to index for semantic search.

import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { getDb } from "@/lib/db";
import { cachedDocumentSourceStats, documentSourceStatsAsync, refreshForRequest } from "@/lib/documents/source-stats-cache";
import type { DocumentSourceKind as CreatableDocumentSourceKind, DocumentSourceStats } from "@/api/document-sources";
export type { DocumentSourceStats } from "@/api/document-sources";

// ADR-0026 — `kind` discriminates local-folder sources from remote ones
// (Jira projects, Confluence spaces, saved JQL/CQL, on-demand URL). `config`
// is a JSON-encoded per-kind blob. `last_cursor` is a per-source incremental
// watermark (used by remote indexers to do incremental syncs).
// ADR-0029 added `github_pulls` (PRs of one repo) and `github_repo` (text
// files on one branch of one repo).
export type DocumentSourceKind =
  | CreatableDocumentSourceKind
  | "on_demand_url";

export interface DocumentSourceRow {
  id: string;
  path: string;
  label: string | null;
  enabled: number;
  last_scan_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  kind: DocumentSourceKind;
  config: string | null;       // JSON; null for local_folder
  last_cursor: string | null;  // incremental watermark; null for local_folder
  // ADR-0133: when the source was disabled, for the opt-in index-retention
  // sweep. Null while enabled (and for rows created before the migration
  // until they are next disabled).
  disabled_at: string | null;
}

const now = () => new Date().toISOString();

export function listDocumentSources(): DocumentSourceRow[] {
  return getDb()
    .prepare("SELECT * FROM document_sources ORDER BY created_at ASC")
    .all() as unknown as DocumentSourceRow[];
}

export function listEnabledDocumentSources(): DocumentSourceRow[] {
  return getDb()
    .prepare("SELECT * FROM document_sources WHERE enabled=1 ORDER BY created_at ASC")
    .all() as unknown as DocumentSourceRow[];
}

export function getDocumentSource(id: string): DocumentSourceRow | null {
  const row = getDb().prepare("SELECT * FROM document_sources WHERE id=?").get(id);
  return (row as DocumentSourceRow | undefined) ?? null;
}

export function getDocumentSourceByPath(path: string): DocumentSourceRow | null {
  const row = getDb().prepare("SELECT * FROM document_sources WHERE path=?").get(path);
  return (row as DocumentSourceRow | undefined) ?? null;
}

export function createDocumentSource(input: {
  path: string;
  label?: string | null;
  kind?: DocumentSourceKind;
  config?: Record<string, unknown> | null;
}): DocumentSourceRow {
  const id = randomUUID();
  const t = now();
  const kind = input.kind ?? "local_folder";
  const config = input.config ? JSON.stringify(input.config) : null;
  getDb()
    .prepare(
      `INSERT INTO document_sources
       (id, path, label, enabled, last_scan_at, last_error, created_at, updated_at, kind, config, last_cursor, disabled_at)
       VALUES (?, ?, ?, 1, NULL, NULL, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(id, input.path, input.label ?? null, t, t, kind, config);
  return {
    id,
    path: input.path,
    label: input.label ?? null,
    enabled: 1,
    last_scan_at: null,
    last_error: null,
    created_at: t,
    updated_at: t,
    kind,
    config,
    last_cursor: null,
    disabled_at: null,
  };
}

// Parsed-config accessor — JSON.parse on every call would be fine at our
// scale but this helper keeps call sites tidy.
export function parseSourceConfig<T = Record<string, unknown>>(
  row: DocumentSourceRow,
): T | null {
  if (!row.config) return null;
  try { return JSON.parse(row.config) as T; } catch { return null; }
}

export function updateDocumentSourceCursor(id: string, cursor: string | null): void {
  getDb()
    .prepare("UPDATE document_sources SET last_cursor=?, updated_at=? WHERE id=?")
    .run(cursor, now(), id);
}

export function updateDocumentSource(
  id: string,
  patch: { label?: string | null; enabled?: boolean },
): DocumentSourceRow | null {
  const existing = getDocumentSource(id);
  if (!existing) return null;
  const t = now();
  const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0;
  // ADR-0133: start the retention clock on the enabled→disabled transition,
  // keep it across label edits, and clear it when the source is re-enabled.
  const disabledAt = enabled === 1
    ? null
    : (existing.enabled === 1 || existing.disabled_at === null ? t : existing.disabled_at);
  getDb()
    .prepare(
      `UPDATE document_sources SET label=?, enabled=?, disabled_at=?, updated_at=? WHERE id=?`,
    )
    .run(
      patch.label === undefined ? existing.label : patch.label,
      enabled,
      disabledAt,
      t,
      id,
    );
  return getDocumentSource(id);
}

export function deleteDocumentSource(id: string): boolean {
  // ON DELETE CASCADE handles documents + chunks.
  return (
    (getDb()
      .prepare("DELETE FROM document_sources WHERE id=?")
      .run(id) as { changes: number }).changes > 0
  );
}

export function markSourceScanned(
  id: string,
  error?: string | null,
): void {
  getDb()
    .prepare(
      "UPDATE document_sources SET last_scan_at=?, last_error=?, updated_at=? WHERE id=?",
    )
    .run(now(), error ?? null, now(), id);
}

interface SourceStatsRow extends DocumentSourceRow, DocumentSourceStats {
  [column: string]: SQLOutputValue;
}

const SOURCE_STATS_QUERY = `
  SELECT s.*, s.id AS source_id,
         COUNT(d.id) AS document_count,
         COALESCE(SUM(d.chunk_count), 0) AS chunk_count
  FROM document_sources s
  LEFT JOIN documents d ON d.source_id = s.id`;

export function listDocumentSourcesWithStats(): Array<{ source: DocumentSourceRow; stats: DocumentSourceStats }> {
  const rows = getDb().prepare(`${SOURCE_STATS_QUERY} GROUP BY s.id ORDER BY s.created_at ASC`)
    .all();
  return rows.map((row) => {
    const { source_id, document_count, chunk_count, ...source } = row as SourceStatsRow;
    return { source, stats: { source_id, document_count, chunk_count } };
  });
}

/**
 * Request-path read. The document count and the sum of the maintained
 * `documents.chunk_count` are index-only over `documents` (~35 ms for every
 * source on a 51k-document corpus), so the cached snapshot is served directly
 * and refreshed behind the response. Neither counter scans `document_chunks`.
 */
export async function listDocumentSourcesWithStatsAsync(): Promise<Array<{ source: DocumentSourceRow; stats: DocumentSourceStats }>> {
  await refreshForRequest();
  return listDocumentSources().map((source) => ({
    source,
    stats: cachedDocumentSourceStats(source.id) ?? { source_id: source.id, document_count: 0, chunk_count: 0 },
  }));
}

export async function getDocumentSourceStatsAsync(sourceId: string): Promise<DocumentSourceStats> {
  return documentSourceStatsAsync(sourceId);
}

export function getDocumentSourceStats(sourceId: string): DocumentSourceStats {
  const row = getDb().prepare(`${SOURCE_STATS_QUERY} WHERE s.id=? GROUP BY s.id`)
    .get(sourceId) as SourceStatsRow | undefined;
  return {
    source_id: sourceId,
    document_count: row?.document_count ?? 0,
    chunk_count: row?.chunk_count ?? 0,
  };
}
