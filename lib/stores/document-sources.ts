// CRUD for the `document_sources` table (ADR-0024). A source is a folder
// the user has asked Jarela to index for semantic search.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

// ADR-0026 — `kind` discriminates local-folder sources from remote ones
// (Jira projects, Confluence spaces, saved JQL/CQL, on-demand URL). `config`
// is a JSON-encoded per-kind blob. `last_cursor` is a per-source incremental
// watermark (used by remote indexers to do incremental syncs).
// ADR-0029 added `github_pulls` (PRs of one repo) and `github_repo` (text
// files on one branch of one repo).
export type DocumentSourceKind =
  | "local_folder"
  | "confluence_space"
  | "confluence_cql"
  | "jira_project"
  | "jira_jql"
  | "github_pulls"
  | "github_repo"
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
       (id, path, label, enabled, last_scan_at, last_error, created_at, updated_at, kind, config, last_cursor)
       VALUES (?, ?, ?, 1, NULL, NULL, ?, ?, ?, ?, NULL)`,
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
  getDb()
    .prepare(
      `UPDATE document_sources SET label=?, enabled=?, updated_at=? WHERE id=?`,
    )
    .run(
      patch.label === undefined ? existing.label : patch.label,
      patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0,
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

export interface DocumentSourceStats {
  source_id: string;
  document_count: number;
  chunk_count: number;
  embedded_chunk_count: number;
}

export function getDocumentSourceStats(sourceId: string): DocumentSourceStats {
  const db = getDb();
  const docs = db
    .prepare("SELECT COUNT(*) AS n FROM documents WHERE source_id=?")
    .get(sourceId) as { n: number };
  const chunks = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM document_chunks dc JOIN documents d ON dc.document_id = d.id
       WHERE d.source_id=?`,
    )
    .get(sourceId) as { n: number };
  const embedded = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM document_chunks dc JOIN documents d ON dc.document_id = d.id
       WHERE d.source_id=? AND dc.embedding IS NOT NULL`,
    )
    .get(sourceId) as { n: number };
  return {
    source_id: sourceId,
    document_count: docs.n,
    chunk_count: chunks.n,
    embedded_chunk_count: embedded.n,
  };
}
