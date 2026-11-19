import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarela-source-stats-"));
process.env.JARELA_DB_DIR = root;

const { getDb, closeDb } = await import("@/lib/db");
const { closeReadPool } = await import("@/lib/db/read-pool");
const cache = await import("./source-stats-cache");

afterAll(async () => {
  await closeReadPool();
  closeDb();
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

afterEach(() => {
  cache.__resetDocumentSourceStatsForTests();
  vi.restoreAllMocks();
});

function seed(sourceId: string, chunks: number, embedded: number): void {
  const db = getDb();
  db.prepare("INSERT INTO document_sources (id, path, label, enabled, created_at, updated_at) VALUES (?,?,?,1,?,?)")
    .run(sourceId, `/docs/${sourceId}`, sourceId, "2026-01-01", "2026-01-01");
  db.prepare("INSERT INTO documents (id, source_id, rel_path, path, content_hash, mtime_ms, size_bytes, last_indexed_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(`doc-${sourceId}`, sourceId, "a.md", `/docs/${sourceId}/a.md`, "hash", 1, 1, "2026-01-01");
  for (let index = 0; index < chunks; index += 1) {
    db.prepare("INSERT INTO document_chunks (id, document_id, chunk_index, text, start_offset, end_offset, embedding, embedding_model_signature) VALUES (?,?,?,?,?,?,?,?)")
      .run(`${sourceId}-${index}`, `doc-${sourceId}`, index, "text", 0, 4, index < embedded ? "[1,0]" : null, index < embedded ? "sig" : null);
  }
}

describe("document source stats cache", () => {
  // The prompt asked for a full-corpus COUNT on every turn; on a live install
  // that is ~3s of synchronous SQLite per turn and freezes the whole app.
  it("serves counters from the cache and never counts on the caller's thread", async () => {
    seed("source-a", 3, 2);
    seed("source-b", 1, 0);

    expect(cache.cachedDocumentSourceStats("source-a")).toBeNull();
    expect(cache.documentSourceStatsAgeMs()).toBeNull();

    await cache.refreshDocumentSourceStats();

    expect(cache.cachedDocumentSourceStats("source-a")).toEqual({
      source_id: "source-a", document_count: 1,
    });
    expect(cache.cachedDocumentSourceStats("source-b")).toMatchObject({ document_count: 1 });
    expect(cache.documentSourceStatsAgeMs()).toBeGreaterThanOrEqual(0);
  });

  it("shares one in-flight refresh between concurrent callers", async () => {
    seed("source-c", 1, 1);
    const rowsSpy = vi.spyOn(await import("@/lib/db/read-pool"), "readAppRows");
    await Promise.all([
      cache.refreshDocumentSourceStats(),
      cache.refreshDocumentSourceStats(),
      cache.refreshDocumentSourceStats(),
    ]);
    expect(rowsSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous snapshot when a refresh fails", async () => {
    seed("source-d", 1, 1);
    await cache.refreshDocumentSourceStats();
    const before = cache.cachedDocumentSourceStats("source-d");
    const pool = await import("@/lib/db/read-pool");
    const failure = vi.spyOn(pool, "readAppRows").mockRejectedValueOnce(new Error("pool offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(cache.refreshDocumentSourceStats()).rejects.toThrow("pool offline");

    expect(cache.cachedDocumentSourceStats("source-d")).toEqual(before);
    expect(warn).toHaveBeenCalled();
    failure.mockRestore();
  });

  it("refreshes on demand for request paths without blocking the writer", async () => {
    seed("source-e", 2, 1);
    const stats = await cache.documentSourceStatsAsync("source-e");
    expect(stats).toMatchObject({ source_id: "source-e", document_count: 1 });
    expect(cache.cachedDocumentSourceStats("source-e")).toEqual(stats);
  });

  it("does not block a request on a stale refresh", async () => {
    seed("source-h", 1, 1);
    await cache.refreshDocumentSourceStats();
    const pool = await import("@/lib/db/read-pool");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(pool, "readAppRows").mockImplementation(async () => {
      await gate;
      return [{ source_id: "source-h", document_count: 1 }];
    });

    const started = Date.now();
    await cache.refreshForRequest(-1);
    expect(Date.now() - started).toBeLessThan(500);
    expect(cache.cachedDocumentSourceStats("source-h")).toMatchObject({ document_count: 1 });

    release();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    spy.mockRestore();
  });

  it("falls back to the last snapshot when the pool is unavailable", async () => {
    seed("source-f", 1, 1);
    await cache.refreshDocumentSourceStats();
    const before = cache.cachedDocumentSourceStats("source-f");
    const pool = await import("@/lib/db/read-pool");
    const failure = vi.spyOn(pool, "readAppRows").mockRejectedValue(new Error("pool offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(cache.documentSourceStatsAsync("source-f")).resolves.toEqual(before);

    failure.mockRestore();
    warn.mockRestore();
  });

  it("warms a missing snapshot for synchronous prompt builds and reuses an existing one", async () => {
    seed("source-g", 1, 1);
    const pool = await import("@/lib/db/read-pool");
    const spy = vi.spyOn(pool, "readAppRows");

    expect(cache.warmDocumentSourceStatsIfMissing()).toBe(true);
    await vi.waitFor(() => expect(cache.documentSourceStatsAgeMs()).not.toBeNull());
    expect(cache.cachedDocumentSourceStats("source-g")).toMatchObject({ document_count: 1 });
    expect(spy).toHaveBeenCalledTimes(1);

    const age = cache.documentSourceStatsAgeMs();
    expect(cache.warmDocumentSourceStatsIfMissing()).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(cache.documentSourceStatsAgeMs()).toBeGreaterThanOrEqual(age!));
  });
});
