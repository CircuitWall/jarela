import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarela-doc-lifecycle-"));
process.env.JARELA_DB_DIR = root;

const { closeDb, getDb } = await import("@/lib/db");
const { closeReadPool } = await import("@/lib/db/read-pool");
const lifecycle = await import("./lifecycle");
const { decodeEmbedding } = await import("./embedding-codec");
const {
  createDocumentSource, getDocumentSource, getDocumentSourceStats, updateDocumentSource,
} = await import("@/lib/stores/document-sources");
const {
  getDocumentIndexLifecycleSettings, setDocumentIndexLifecycleSettings,
} = await import("@/lib/stores/app-settings");

const { closeDocumentIndexMaintenancePool } = lifecycle;

afterAll(async () => {
  await closeDocumentIndexMaintenancePool();
  await closeReadPool();
  closeDb();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows file lock */ }
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM document_chunks").run();
  db.prepare("DELETE FROM documents").run();
  db.prepare("DELETE FROM document_sources").run();
  lifecycle.__resetDocumentIndexLifecycleForTests();
  setDocumentIndexLifecycleSettings({ purge_disabled_after_days: 0 });
});

function seedSource(path: string, opts: {
  enabled?: boolean;
  chunks?: string[];
  disabledAt?: string;
} = {}) {
  const db = getDb();
  const source = createDocumentSource({ path, label: path });
  const documentId = `doc-${path}`;
  const chunks = opts.chunks ?? [];
  db.prepare(
    `INSERT INTO documents
     (id, source_id, path, rel_path, mtime_ms, size_bytes, content_hash, last_indexed_at, chunk_count)
     VALUES (?, ?, ?, 'a.md', 1, 10, 'synthetic-hash', '2026-01-01T00:00:00Z', ?)`,
  ).run(documentId, source.id, `${path}/a.md`, chunks.length);
  const insert = db.prepare(
    `INSERT INTO document_chunks
     (id, document_id, chunk_index, text, start_offset, end_offset, embedding)
     VALUES (?, ?, ?, ?, 0, ?, NULL)`,
  );
  for (let index = 0; index < chunks.length; index += 1) {
    insert.run(`chunk-${path}-${index}`, documentId, index, chunks[index], chunks[index].length);
  }
  if (opts.enabled === false) updateDocumentSource(source.id, { enabled: false });
  if (opts.disabledAt) {
    db.prepare("UPDATE document_sources SET disabled_at=? WHERE id=?").run(opts.disabledAt, source.id);
  }
  return getDocumentSource(source.id)!;
}

function count(table: "documents" | "document_chunks", sourceId: string): number {
  const where = table === "documents"
    ? "source_id=?"
    : "document_id IN (SELECT id FROM documents WHERE source_id=?)";
  const row = getDb().prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(sourceId) as { count: number };
  return row.count;
}

describe("document index inventory", () => {
  it("counts documents and chunks without scanning the chunk table", async () => {
    seedSource("source-a", { chunks: ["one", "two"] });
    seedSource("source-b", { chunks: [] });

    const inventory = await lifecycle.getDocumentIndexInventory();

    expect(inventory.document_count).toBe(2);
    expect(inventory.chunk_count).toBe(2);
    expect(inventory.size_bytes).toBeGreaterThan(0);
    expect(inventory.auto_vacuum).toBe("incremental");
    expect(getDocumentIndexLifecycleSettings()).toEqual({ purge_disabled_after_days: 0 });
    expect(setDocumentIndexLifecycleSettings({ purge_disabled_after_days: 30 }))
      .toEqual({ purge_disabled_after_days: 30 });
  });
});

describe("purging source indexes", () => {
  it("deletes one source's documents and chunks but keeps the source row", async () => {
    const target = seedSource("target", { chunks: ["one", "two"] });
    const sibling = seedSource("sibling", { chunks: ["three"] });

    const result = await lifecycle.purgeSourceIndex(target.id);

    expect(result).toEqual({ source_id: target.id, documents: 1, chunks: 2 });
    expect(getDocumentSource(target.id)).not.toBeNull();
    expect(count("documents", target.id)).toBe(0);
    expect(count("document_chunks", target.id)).toBe(0);
    expect(getDocumentSourceStats(target.id)).toEqual({
      source_id: target.id, document_count: 0, chunk_count: 0,
    });
    expect(count("documents", sibling.id)).toBe(1);
    expect(count("document_chunks", sibling.id)).toBe(1);
  });

  it("only purges disabled sources past the retention window", async () => {
    const expired = seedSource("expired", { enabled: false, chunks: ["old"] });
    const recent = seedSource("recent", { enabled: false, chunks: ["new"] });
    const active = seedSource("active", { chunks: ["active"] });
    getDb().prepare("UPDATE document_sources SET disabled_at=? WHERE id=?")
      .run("2026-01-01T00:00:00.000Z", expired.id);

    const result = await lifecycle.purgeDisabledSourceIndexes({
      olderThanDays: 7,
      now: new Date("2026-01-20T00:00:00.000Z"),
    });

    expect(result.sources.map((source) => source.source_id)).toEqual([expired.id]);
    expect(result.chunks).toBe(1);
    expect(count("documents", expired.id)).toBe(0);
    expect(count("documents", recent.id)).toBe(1);
    expect(count("documents", active.id)).toBe(1);
  });

  it("starts and clears the retention clock on the enabled transition", () => {
    const source = createDocumentSource({ path: "clock" });
    expect(source.disabled_at).toBeNull();
    const disabled = updateDocumentSource(source.id, { enabled: false })!;
    expect(disabled.disabled_at).toEqual(expect.any(String));
    const renamed = updateDocumentSource(source.id, { label: "Renamed" })!;
    expect(renamed.disabled_at).toBe(disabled.disabled_at);
    const enabled = updateDocumentSource(source.id, { enabled: true })!;
    expect(enabled.disabled_at).toBeNull();
  });
});

describe("embedding format rewrite", () => {
  it("rewrites legacy JSON embeddings to BLOBs and is idempotent", async () => {
    seedSource("legacy", { chunks: [] });
    const db = getDb();
    db.prepare("UPDATE documents SET chunk_count=2 WHERE id=?").run("doc-legacy");
    const insert = db.prepare(
      `INSERT INTO document_chunks
       (id, document_id, chunk_index, text, start_offset, end_offset, embedding)
       VALUES (?, ?, ?, ?, 0, 5, ?)`,
    );
    insert.run("legacy-0", "doc-legacy", 0, "first", JSON.stringify([0.123456789, -0.987654321, 0.5, 1]));
    insert.run("legacy-1", "doc-legacy", 1, "second", JSON.stringify([0.314159265, 1, -1, 0.25]));

    const first = await lifecycle.rewriteLegacyDocumentEmbeddings({ batchSize: 1, budgetMs: 10_000 });

    expect(first).toMatchObject({ scanned: 2, rewritten: 2, skipped: 0, completed: true });
    expect(first.bytes_before).toBeGreaterThan(first.bytes_after);
    const rows = db.prepare(
      "SELECT embedding, typeof(embedding) AS storage FROM document_chunks WHERE document_id=? ORDER BY chunk_index",
    ).all("doc-legacy") as Array<{ embedding: Uint8Array; storage: string }>;
    expect(rows.map((row) => row.storage)).toEqual(["blob", "blob"]);
    expect(decodeEmbedding(rows[0].embedding)).toEqual([Math.fround(0.123456789), Math.fround(-0.987654321), 0.5, 1]);
    expect(decodeEmbedding(rows[1].embedding)).toEqual([Math.fround(0.314159265), 1, -1, 0.25]);

    expect(await lifecycle.rewriteLegacyDocumentEmbeddings({ batchSize: 1 }))
      .toMatchObject({ scanned: 0, rewritten: 0, completed: true });
  });
});

describe("space reclamation", () => {
  it("reclaims free pages incrementally after a purge", async () => {
    // Seed the source that will be purged first so its chunks sit before the
    // retained source's chunks in the file; deleting them leaves non-trailing
    // free pages that incremental vacuum must relocate and truncate.
    const dropped = seedSource("dropped", { chunks: Array.from({ length: 200 }, () => "d".repeat(1000)) });
    seedSource("retained", { chunks: Array.from({ length: 20 }, () => "r".repeat(1000)) });
    await lifecycle.purgeSourceIndex(dropped.id);

    const before = await lifecycle.getDocumentIndexInventory();
    const result = await lifecycle.reclaimIndexSpace({ budgetMs: 10_000, batchPages: 64 });

    expect(result.auto_vacuum).toBe("incremental");
    expect(result.free_bytes_after).toBeLessThanOrEqual(result.free_bytes_before);
    expect(result.reclaimed_bytes).toBe(result.free_bytes_before - result.free_bytes_after);
    expect(result.completed).toBe(result.free_bytes_after === 0);
    if (before.free_bytes > 0) expect(result.reclaimed_bytes).toBeGreaterThan(0);
  });

  it("compacts the database and reports incremental auto-vacuum", async () => {
    const source = seedSource("vacuum", { chunks: Array.from({ length: 100 }, () => "v".repeat(500)) });
    await lifecycle.purgeSourceIndex(source.id);
    const before = await lifecycle.getDocumentIndexInventory();

    const result = await lifecycle.vacuumIndexDatabase();

    expect(result.auto_vacuum).toBe("incremental");
    expect(result.size_bytes_after).toBeLessThanOrEqual(before.size_bytes);
    expect(result.reclaimed_bytes).toBe(Math.max(0, result.size_bytes_before - result.size_bytes_after));
    expect((await lifecycle.getDocumentIndexInventory()).auto_vacuum).toBe("incremental");
  });
});

describe("maintenance runner", () => {
  it("serializes actions and reports the outcome", async () => {
    const source = seedSource("runner", { chunks: ["one", "two"] });

    const started = lifecycle.startDocumentIndexMaintenance({
      action: "purge_source", source_id: source.id,
    });
    expect(started.started).toBe(true);
    expect(started.status.running).toBe(true);
    expect(started.status.action).toBe("purge_source");
    expect(lifecycle.startDocumentIndexMaintenance({ action: "reclaim" }).started).toBe(false);

    await lifecycle.waitForDocumentIndexMaintenance();

    const status = lifecycle.getDocumentIndexMaintenanceStatus();
    expect(status.running).toBe(false);
    expect(status.error).toBeNull();
    expect(status.summary).toContain("Purged 2 chunks");
    expect(status.finished_at).toEqual(expect.any(String));
    expect(count("documents", source.id)).toBe(0);
  });

  it("runs the retention sweep from the scheduler path", async () => {
    setDocumentIndexLifecycleSettings({ purge_disabled_after_days: 7 });
    const source = seedSource("sweep", { enabled: false, chunks: ["one"] });
    getDb().prepare("UPDATE document_sources SET disabled_at=? WHERE id=?")
      .run("2026-01-01T00:00:00.000Z", source.id);

    expect(await lifecycle.runDocumentIndexLifecycleSweep()).toBe(true);
    await lifecycle.waitForDocumentIndexMaintenance();

    expect(count("documents", source.id)).toBe(0);
    expect(lifecycle.getDocumentIndexMaintenanceStatus().action).toBe("lifecycle");
  });
});
