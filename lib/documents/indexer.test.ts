import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated SQLite per test run; tmp source root for the file fixtures.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-indexer-"));
process.env.JARELA_DB_DIR = tmpRoot;
const sourceRoot = mkdtempSync(join(tmpdir(), "jarela-indexer-fixtures-"));

// embedBestEffort is controlled per-test via `embedImpl` so each test can
// script a different provider response (success / transient / terminal)
// without re-mocking the module.
type EmbedResult = {
  vectors: (number[] | null)[];
  error: string | null;
  failed: number;
  terminal: boolean[];
};
let embedImpl: (texts: string[]) => EmbedResult;
const embedBestEffortSpy = vi.fn(async (texts: string[]) => embedImpl(texts));

vi.mock("@/lib/embeddings", () => ({
  embed: vi.fn().mockResolvedValue(null),
  embedBestEffort: (texts: string[]) => embedBestEffortSpy(texts),
  upsertMemoryEmbedCache: () => {},
  evictMemoryEmbedCache: () => {},
  upsertMessageEmbedCache: () => {},
  resetMessageEmbedCache: () => {},
}));

const { indexSource } = await import("./indexer");
const { getDb } = await import("@/lib/db");
const { createDocumentSource } = await import("@/lib/stores/document-sources");

let sourceId: string;
let sourceRow: Awaited<ReturnType<typeof createDocumentSource>>;

beforeEach(() => {
  getDb().prepare("DELETE FROM document_chunks").run();
  getDb().prepare("DELETE FROM documents").run();
  getDb().prepare("DELETE FROM document_sources").run();
  // Each test walks the whole source directory, so leftover files from a
  // prior test (e.g. "bad-content.txt") would get picked up as new files
  // and skew the embedBestEffort call count — start with an empty dir.
  rmSync(sourceRoot, { recursive: true, force: true });
  mkdirSync(sourceRoot, { recursive: true });
  sourceRow = createDocumentSource({ path: sourceRoot, label: null });
  sourceId = sourceRow.id;
  embedBestEffortSpy.mockClear();
  embedImpl = (texts) => ({
    vectors: texts.map(() => [0.1]),
    error: null,
    failed: 0,
    terminal: texts.map(() => false),
  });
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  try { rmSync(sourceRoot, { recursive: true, force: true }); } catch {}
});

function chunkRows(): Array<{ embedding: string | null; embed_failed_at: string | null }> {
  return getDb()
    .prepare(
      `SELECT c.embedding, c.embed_failed_at
       FROM document_chunks c JOIN documents d ON d.id = c.document_id
       WHERE d.source_id = ?`,
    )
    .all(sourceId) as unknown as Array<{ embedding: string | null; embed_failed_at: string | null }>;
}

describe("indexSource — terminal vs transient embedding failures (issue #597)", () => {
  it("stops retrying a chunk whose embedding failed terminally", async () => {
    const abs = join(sourceRoot, "bad-content.txt");
    writeFileSync(abs, "some content the provider will permanently reject");

    embedImpl = (texts) => ({
      vectors: texts.map(() => null),
      error: "HTTP 400 content rejected",
      failed: texts.length,
      terminal: texts.map(() => true),
    });

    await indexSource(sourceRow);
    expect(embedBestEffortSpy).toHaveBeenCalledTimes(1);
    let rows = chunkRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].embedding).toBeNull();
    expect(rows[0].embed_failed_at).not.toBeNull();

    // Second tick over the same unchanged file must not resubmit the
    // permanently-failed chunk — this is the "forever" bug from #597.
    embedBestEffortSpy.mockClear();
    await indexSource(sourceRow);
    expect(embedBestEffortSpy).not.toHaveBeenCalled();

    rows = chunkRows();
    expect(rows[0].embedding).toBeNull();
    expect(rows[0].embed_failed_at).not.toBeNull();
  });

  it("keeps retrying a chunk whose embedding failed transiently", async () => {
    const abs = join(sourceRoot, "rate-limited.txt");
    writeFileSync(abs, "content that hits a transient rate limit");

    embedImpl = (texts) => ({
      vectors: texts.map(() => null),
      error: "HTTP 429 rate limited",
      failed: texts.length,
      terminal: texts.map(() => false),
    });

    await indexSource(sourceRow);
    expect(embedBestEffortSpy).toHaveBeenCalledTimes(1);
    let rows = chunkRows();
    expect(rows[0].embedding).toBeNull();
    expect(rows[0].embed_failed_at).toBeNull();

    // Next tick over the same unchanged file must retry — nothing marked
    // it permanently failed.
    embedBestEffortSpy.mockClear();
    embedImpl = (texts) => ({
      vectors: texts.map(() => [0.2]),
      error: null,
      failed: 0,
      terminal: texts.map(() => false),
    });
    await indexSource(sourceRow);
    expect(embedBestEffortSpy).toHaveBeenCalledTimes(1);

    rows = chunkRows();
    expect(rows[0].embedding).not.toBeNull();
    expect(rows[0].embed_failed_at).toBeNull();
  });

  it("force-reembeds unchanged files during a manual source rescan", async () => {
    const abs = join(sourceRoot, "stable.txt");
    writeFileSync(abs, "stable content whose embedding model will change");

    await indexSource(sourceRow);
    expect(JSON.parse(chunkRows()[0].embedding!)).toEqual([0.1]);

    embedBestEffortSpy.mockClear();
    embedImpl = (texts) => ({
      vectors: texts.map(() => [0.9]),
      error: null,
      failed: 0,
      terminal: texts.map(() => false),
    });
    const stats = await indexSource(sourceRow, { maxFiles: Number.MAX_SAFE_INTEGER, forceReembed: true });

    expect(embedBestEffortSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(chunkRows()[0].embedding!)).toEqual([0.9]);
    expect(stats.updated).toBe(1);
  });
});
