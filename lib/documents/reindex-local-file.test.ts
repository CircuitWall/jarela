import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated SQLite per test run; tmp source root for the file fixtures.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-reindex-"));
process.env.JARELA_DB_DIR = tmpRoot;
const sourceRoot = mkdtempSync(join(tmpdir(), "jarela-reindex-fixtures-"));

// Stub the embedder so the test doesn't try to dial out — every input
// gets a `null` vector so we exercise the "no embeddings, substring
// fallback only" path.
vi.mock("@/lib/embeddings", () => ({
  embed: vi.fn().mockResolvedValue(null),
  embedBestEffort: vi.fn(async (texts: string[]) => ({
    vectors: texts.map(() => null),
    error: null,
    failed: texts.length,
  })),
}));

const { reindexLocalFile } = await import("./reindex-local-file");
const { upsertLocalDocument, hashContent } = await import("./indexer");
const { getDb } = await import("@/lib/db");
const { createDocumentSource } = await import("@/lib/stores/document-sources");

let sourceId: string;

beforeEach(() => {
  // Clear any rows left by the previous test.
  getDb().prepare("DELETE FROM document_chunks").run();
  getDb().prepare("DELETE FROM documents").run();
  getDb().prepare("DELETE FROM document_sources").run();
  const row = createDocumentSource({ path: sourceRoot, label: null });
  sourceId = row.id;
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  try { rmSync(sourceRoot, { recursive: true, force: true }); } catch {}
});

describe("reindexLocalFile (ADR-0028)", () => {
  it("indexes a new file (added)", async () => {
    const abs = join(sourceRoot, "hello.md");
    writeFileSync(abs, "# Hello\n\nThis is a fresh document.");

    const result = await reindexLocalFile({ source_id: sourceId, abs });
    expect(result.preview).toMatch(/^added /);

    const row = getDb()
      .prepare("SELECT id, content_hash, chunk_count FROM documents WHERE source_id=? AND path=?")
      .get(sourceId, abs) as { id: string; content_hash: string; chunk_count: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.chunk_count).toBeGreaterThan(0);
  });

  it("returns 'unchanged' when content hash matches even after touch", async () => {
    const abs = join(sourceRoot, "touch-me.md");
    writeFileSync(abs, "# Touch me\n\nSame content.");
    await reindexLocalFile({ source_id: sourceId, abs });
    const before = getDb()
      .prepare("SELECT content_hash, chunk_count FROM documents WHERE path=?")
      .get(abs) as { content_hash: string; chunk_count: number };

    // Touch — bumps mtime but leaves content alone.
    const future = new Date(Date.now() + 5_000);
    utimesSync(abs, future, future);

    const result = await reindexLocalFile({ source_id: sourceId, abs });
    expect(result.preview).toMatch(/^unchanged /);

    const after = getDb()
      .prepare("SELECT content_hash, chunk_count FROM documents WHERE path=?")
      .get(abs) as { content_hash: string; chunk_count: number };
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.chunk_count).toBe(before.chunk_count);
  });

  it("returns 'updated' on real content change", async () => {
    const abs = join(sourceRoot, "edit-me.md");
    writeFileSync(abs, "version one");
    await reindexLocalFile({ source_id: sourceId, abs });

    writeFileSync(abs, "version two — quite different now");
    const result = await reindexLocalFile({ source_id: sourceId, abs });
    expect(result.preview).toMatch(/^updated /);
  });

  it("returns 'deleted' (and removes the row) when the file is gone", async () => {
    const abs = join(sourceRoot, "ephemeral.md");
    writeFileSync(abs, "short-lived doc");
    await reindexLocalFile({ source_id: sourceId, abs });
    expect(
      getDb().prepare("SELECT 1 FROM documents WHERE path=?").get(abs),
    ).toBeDefined();

    unlinkSync(abs);
    const result = await reindexLocalFile({ source_id: sourceId, abs });
    expect(result.preview).toMatch(/^deleted /);
    expect(
      getDb().prepare("SELECT 1 FROM documents WHERE path=?").get(abs),
    ).toBeUndefined();
  });

  it("skips disallowed extensions", async () => {
    const abs = join(sourceRoot, "image.png");
    writeFileSync(abs, "fake-png-bytes");
    const result = await reindexLocalFile({ source_id: sourceId, abs });
    expect(result.preview).toMatch(/^skipped: ext not allowed/);
    expect(
      getDb().prepare("SELECT 1 FROM documents WHERE path=?").get(abs),
    ).toBeUndefined();
  });

  it("skips when the source doesn't exist", async () => {
    const abs = join(sourceRoot, "orphan.md");
    writeFileSync(abs, "doesn't matter");
    const result = await reindexLocalFile({
      source_id: "definitely-not-a-real-source-id",
      abs,
    });
    expect(result.preview).toMatch(/^skipped: source/);
  });

  // Regression: full sweep and fs-watch can race on the same
  // (source_id, path). Both call upsertLocalDocument with
  // existingId=undefined and trip UNIQUE(source_id, path) on the
  // second INSERT. Fix uses ON CONFLICT DO NOTHING + winner adoption.
  it("upsertLocalDocument is idempotent across concurrent inserts (UNIQUE race)", async () => {
    const abs = join(sourceRoot, "race.md");
    const rel = "race.md";
    writeFileSync(abs, "racing writers");
    const text = "racing writers";
    const hash = hashContent(text);
    const f = { abs, rel, mtime_ms: Date.now(), size: text.length };

    // Two concurrent calls, both with existingId=undefined â€” this is
    // exactly the pattern that used to throw `UNIQUE constraint failed`.
    await expect(
      Promise.all([
        upsertLocalDocument(sourceId, f, text, hash, undefined),
        upsertLocalDocument(sourceId, f, text, hash, undefined),
      ]),
    ).resolves.toBeDefined();

    // Exactly one row should exist for that (source_id, path).
    const rows = getDb()
      .prepare("SELECT id FROM documents WHERE source_id=? AND path=?")
      .all(sourceId, abs);
    expect(rows.length).toBe(1);
  });
});
