import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarela-source-stats-"));
process.env.JARELA_DB_DIR = root;
const { closeDb, getDb } = await import("@/lib/db");
const {
  createDocumentSource, getDocumentSourceStats, listDocumentSourcesWithStats,
  listDocumentSources, listEnabledDocumentSources, getDocumentSource,
  getDocumentSourceByPath, parseSourceConfig, updateDocumentSource,
  updateDocumentSourceCursor, deleteDocumentSource, markSourceScanned,
} = await import("./document-sources");

beforeEach(() => {
  getDb().prepare("DELETE FROM document_sources").run();
});

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

function document(sourceId: string, id: string, embeddings: Array<string | null>) {
  const db = getDb();
  db.prepare(`INSERT INTO documents
    (id, source_id, path, rel_path, mtime_ms, size_bytes, content_hash, last_indexed_at)
    VALUES (?, ?, ?, ?, 0, 0, 'synthetic', '2026-10-30T00:00:00Z')`).run(id, sourceId, id, id);
  embeddings.forEach((embedding, index) => {
    db.prepare(`INSERT INTO document_chunks
      (id, document_id, chunk_index, text, start_offset, end_offset, embedding)
      VALUES (?, ?, ?, 'synthetic', 0, 9, ?)`).run(`${id}-${index}`, id, index, embedding);
  });
}

it("returns exact counts for empty sources, chunkless documents, and mixed embeddings", () => {
  const empty = createDocumentSource({ path: "synthetic-empty" });
  const populated = createDocumentSource({ path: "synthetic-populated" });
  const other = createDocumentSource({ path: "synthetic-other" });
  other.enabled = 0;
  getDb().prepare("UPDATE document_sources SET enabled=0 WHERE id=?").run(other.id);
  for (const [index, source] of [empty, populated, other].entries()) {
    source.created_at = `2026-10-${20 + index}T00:00:00Z`;
    getDb().prepare("UPDATE document_sources SET created_at=? WHERE id=?").run(source.created_at, source.id);
  }
  document(populated.id, "one", ["[1]", null, "[2]"]);
  document(populated.id, "two", []);
  document(other.id, "other", [null]);
  const rows = listDocumentSourcesWithStats();
  expect(rows.map(({ source }) => source)).toEqual([empty, populated, other]);
  expect(rows.map(({ stats }) => stats)).toEqual([
    { source_id: empty.id, document_count: 0, chunk_count: 0, embedded_chunk_count: 0 },
    { source_id: populated.id, document_count: 2, chunk_count: 3, embedded_chunk_count: 2 },
    { source_id: other.id, document_count: 1, chunk_count: 1, embedded_chunk_count: 0 },
  ]);
  for (const { source, stats } of rows) expect(getDocumentSourceStats(source.id)).toEqual(stats);
  expect(getDocumentSourceStats("missing")).toEqual({
    source_id: "missing", document_count: 0, chunk_count: 0, embedded_chunk_count: 0,
  });
});

it("executes one query for the collection regardless of source count", () => {
  for (let index = 0; index < 30; index++) createDocumentSource({ path: `synthetic-${index}` });
  const prepare = vi.spyOn(getDb(), "prepare");
  try {
    expect(listDocumentSourcesWithStats()).toHaveLength(30);
    expect(prepare).toHaveBeenCalledOnce();
  } finally {
    prepare.mockRestore();
  }
});

it("returns an empty collection without inventing a source", () => {
  expect(listDocumentSourcesWithStats()).toEqual([]);
});

it("preserves omitted fields, clears explicit values and filters disabled sources", () => {
  const local = createDocumentSource({ path: "synthetic-local", label: "Local" });
  const remote = createDocumentSource({ path: "synthetic-remote", kind: "github_repo", config: { branch: "main" } });
  expect(getDocumentSource(local.id)).toEqual(local);
  expect(getDocumentSourceByPath(remote.path)).toEqual(remote);
  expect(getDocumentSource("missing")).toBeNull();
  expect(getDocumentSourceByPath("missing")).toBeNull();
  expect(parseSourceConfig(local)).toBeNull();
  expect(parseSourceConfig(remote)).toEqual({ branch: "main" });
  expect(parseSourceConfig({ ...remote, config: "invalid JSON" })).toBeNull();
  expect(updateDocumentSource("missing", {})).toBeNull();
  expect(updateDocumentSource(local.id, { enabled: false })).toMatchObject({ label: "Local", enabled: 0 });
  expect(listEnabledDocumentSources()).toEqual([remote]);
  expect(listDocumentSources()).toHaveLength(2);
  expect(updateDocumentSource(local.id, { label: null, enabled: true })).toMatchObject({ label: null, enabled: 1 });
  expect(updateDocumentSource(local.id, {})).toMatchObject({ label: null, enabled: 1 });
  updateDocumentSourceCursor(remote.id, "synthetic-cursor");
  expect(getDocumentSource(remote.id)?.last_cursor).toBe("synthetic-cursor");
  updateDocumentSourceCursor(remote.id, null);
  expect(getDocumentSource(remote.id)?.last_cursor).toBeNull();
  markSourceScanned(local.id, "Synthetic scan failure");
  expect(getDocumentSource(local.id)).toMatchObject({ last_error: "Synthetic scan failure", last_scan_at: expect.any(String) });
  markSourceScanned(local.id);
  expect(getDocumentSource(local.id)?.last_error).toBeNull();
});

it("deletes documents and chunks with their source, without touching siblings", () => {
  const source = createDocumentSource({ path: "synthetic-delete" });
  const sibling = createDocumentSource({ path: "synthetic-retain" });
  document(source.id, "synthetic-document", [null]);
  expect(deleteDocumentSource(source.id)).toBe(true);
  expect(deleteDocumentSource(source.id)).toBe(false);
  expect(getDocumentSource(sibling.id)).toEqual(sibling);
  expect(getDb().prepare("SELECT id FROM documents WHERE id=?").get("synthetic-document")).toBeUndefined();
  expect(getDb().prepare("SELECT id FROM document_chunks WHERE document_id=?").get("synthetic-document")).toBeUndefined();
});
