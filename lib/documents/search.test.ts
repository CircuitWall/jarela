import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { defaultDocumentRecallPolicy } from "./recall-policy";

const mocks = vi.hoisted(() => ({
  embedQueryOne: vi.fn(),
  embedQueryWithSignature: vi.fn(),
  localEmbeddingsEnabled: vi.fn(() => true),
  rows: [] as Array<Record<string, unknown>>,
  recallPolicy: vi.fn(),
  cosine: vi.fn((_query: number[], vector: number[]) => vector[0]),
  all: vi.fn(),
  run: vi.fn(() => ({ changes: 1 })),
  prepare: vi.fn(),
  readAppRows: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ prepare: mocks.prepare }),
}));
vi.mock("@/lib/db/read-pool", () => ({
  readAppRows: mocks.readAppRows,
}));
vi.mock("@/lib/embeddings", () => ({
  embedQueryOne: mocks.embedQueryOne,
  embedQueryWithSignature: mocks.embedQueryWithSignature,
  processMessageEmbeddingJobs: vi.fn(async () => 0),
  cosine: mocks.cosine,
}));
vi.mock("@/lib/stores/app-settings", () => ({
  isLocalEmbeddingsEnabled: mocks.localEmbeddingsEnabled,
  getDocumentRecallPolicy: mocks.recallPolicy,
}));

const { searchDocuments, searchDocumentsWithMeta } = await import("./search");
const { encodeEmbedding } = await import("./embedding-codec");

function row(id: string, score: number | null, text: string) {
  return {
    chunk_id: id,
    document_id: `doc-${id}`,
    chunk_index: 0,
    text,
    embedding: score === null ? null : JSON.stringify([score, 1 - score]),
    embedding_model_signature: "test-model",
    source_id: "source-1",
    source_label: "Docs",
    rel_path: `${id}.md`,
    abs_path: `/${id}.md`,
    content_hash: `hash-${id}`,
  };
}

describe("searchDocuments similarity threshold", () => {
  beforeEach(() => {
    mocks.all.mockReset().mockImplementation(() => mocks.rows);
    mocks.run.mockClear();
    mocks.prepare.mockReset().mockImplementation(() => ({ all: mocks.all, run: mocks.run }));
    mocks.readAppRows.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("GROUP BY d.source_id")) {
        const requested = sql.includes("d.source_id = ?") ? String(params[0]) : null;
        const counts = new Map<string, number>();
        for (const candidate of mocks.rows) {
          const sourceId = String(candidate.source_id);
          if (requested && sourceId !== requested) continue;
          counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
        }
        return [...counts.entries()].map(([source_id, chunks]) => ({ source_id, chunks }));
      }
      if (sql.includes("> (?, ?)")) return [];
      const sourceId = String(params[0]);
      const limit = Number(params[params.length - 1]) || mocks.rows.length;
      return mocks.rows
        .filter((candidate) => candidate.source_id === sourceId)
        .slice(0, limit);
    });
    mocks.localEmbeddingsEnabled.mockReturnValue(true);
    mocks.recallPolicy.mockReturnValue(defaultDocumentRecallPolicy());
    mocks.cosine.mockImplementation((_query, vector) => vector[0]);
    mocks.embedQueryOne.mockReset().mockResolvedValue([1, 0]);
    mocks.embedQueryWithSignature.mockReset().mockImplementation(async (texts: string[]) => ({
      vectors: await Promise.all(texts.map((text) => mocks.embedQueryOne(text))),
      modelSignature: "test-model",
    }));
    mocks.rows = [
      row("high", 0.9, "high semantic match"),
      row("borderline", 0.85, "borderline semantic match"),
      row("literal", null, "needle appears in this unembedded chunk"),
    ];
  });

  it("uses the default semantic floor but keeps substring fallback hits", async () => {
    const hits = await searchDocuments("needle");

    expect(hits.map((hit) => hit.document_id)).toEqual(["doc-high", "doc-literal"]);
    expect(hits[1].match).toBe("substring");
  });

  it("allows callers to lower the semantic floor to widen results", async () => {
    const hits = await searchDocuments("needle", { minSimilarity: 0.8 });

    expect(hits.map((hit) => hit.document_id)).toEqual(["doc-high", "doc-borderline", "doc-literal"]);
  });

  it("keeps the conservative fallback floor for unbenchmarked providers", async () => {
    mocks.localEmbeddingsEnabled.mockReturnValue(false);

    const hits = await searchDocuments("needle");

    expect(hits.map((hit) => hit.document_id)).toEqual(["doc-high", "doc-borderline", "doc-literal"]);
  });

  it("excludes every chunk of selected documents, including substring fallback", async () => {
    mocks.recallPolicy.mockReturnValue({
      ...defaultDocumentRecallPolicy(),
      excluded_documents: [{ source_id: "source-1", path: "/literal.md", label: "literal" }],
    });
    mocks.rows.push({ ...row("literal-2", null, "needle again"), abs_path: "/literal.md" });

    expect((await searchDocuments("needle")).map((hit) => hit.document_id)).toEqual(["doc-high"]);
  });

  it("matches exclusions by source and path even after a document id changes", async () => {
    mocks.recallPolicy.mockReturnValue({
      ...defaultDocumentRecallPolicy(),
      excluded_documents: [{ source_id: "source-1", path: "/high.md", label: "high" }],
    });
    mocks.rows = [
      { ...row("new-id", 0.9, "needle"), abs_path: "/high.md" },
      { ...row("other-source", 0.9, "needle"), abs_path: "/high.md", source_id: "source-2" },
    ];

    expect((await searchDocuments("needle")).map((hit) => hit.document_id)).toEqual(["doc-other-source"]);
  });

  it("filters topic matches at the exact threshold before ranking and limiting", async () => {
    mocks.recallPolicy.mockReturnValue({ ...defaultDocumentRecallPolicy(), topics: ["private topic"] });
    mocks.embedQueryOne.mockImplementation(async (q: string) => q === "private topic" ? [0, 1] : [1, 0]);
    mocks.cosine.mockImplementation((query, vector) => query[0] === 0 ? vector[1] : vector[0]);
    mocks.rows = [
      { ...row("private", 0.9, "sensitive"), embedding: "[0.9,0.8]" },
      { ...row("allowed", 0.9, "public"), embedding: "[0.9,0.79]" },
    ];

    expect((await searchDocuments("needle", { limit: 1 })).map((hit) => hit.document_id)).toEqual(["doc-allowed"]);
  });

  it.each([null, [], [0, 0], [NaN, 1]])("fails closed when a topic vector is unavailable or invalid: %j", async (vector) => {
    mocks.recallPolicy.mockReturnValue({ ...defaultDocumentRecallPolicy(), topics: ["private topic"] });
    mocks.embedQueryOne.mockResolvedValue(vector);
    await expect(searchDocuments("needle")).rejects.toThrow("Document search blocked");
  });

  it.each([null, "not-json", "[1,0,0]", "[0,0]", '["wrong",1]'])("fails closed for unchecked chunk vectors: %s", async (embedding) => {
    mocks.recallPolicy.mockReturnValue({ ...defaultDocumentRecallPolicy(), topics: ["private topic"] });
    mocks.rows = [{ ...row("literal", null, "needle"), embedding }];
    await expect(searchDocuments("needle")).rejects.toThrow("Document search blocked");
  });

  it("allows the preview override without embedding excluded topic descriptions", async () => {
    mocks.recallPolicy.mockReturnValue({
      ...defaultDocumentRecallPolicy(), topics: ["private topic"],
      excluded_documents: [{ source_id: "source-1", path: "/high.md", label: "high" }],
    });
    const hits = await searchDocuments("needle", { includeExcluded: true });
    expect(hits.map((hit) => hit.document_id)).toEqual(["doc-high", "doc-literal"]);
    expect(hits[0].excluded).toBe(true);
    expect(mocks.embedQueryOne).not.toHaveBeenCalledWith("private topic");
  });

  it.each([null, "different-model"])("blocks unknown or changed models even with matching dimensions: %s", async (signature) => {
    mocks.recallPolicy.mockReturnValue({ ...defaultDocumentRecallPolicy(), topics: ["private topic"] });
    mocks.rows = [{ ...row("high", 0.9, "needle"), embedding_model_signature: signature }];
    await expect(searchDocuments("needle")).rejects.toThrow("Document search blocked");
  });

  it.each([undefined, "source-1"])("binds the source filter and page size: %s", async (sourceId) => {
    await searchDocuments("needle", { sourceId });
    const sourceQuery = mocks.readAppRows.mock.calls.find(
      ([sql]) => String(sql).includes("GROUP BY d.source_id"),
    );
    expect(sourceQuery).toBeDefined();
    const [sourceSql, sourceParams] = sourceQuery as [string, unknown[]];
    if (sourceId) {
      expect(sourceSql).toContain("d.source_id = ?");
      expect(sourceParams).toEqual([sourceId]);
    } else {
      expect(sourceSql).not.toContain("d.source_id = ?");
      expect(sourceParams).toEqual([]);
    }

    const candidate = mocks.readAppRows.mock.calls.find(
      ([sql]) => String(sql).includes("ORDER BY dc.document_id, dc.chunk_index"),
    );
    expect(candidate).toBeDefined();
    const [sql, params] = candidate as [string, unknown[]];
    expect(sql).toContain("ds.enabled = 1");
    expect(sql).toContain("d.source_id = ?");
    expect(sql).toContain("LIMIT ?");
    expect(params).toEqual(["source-1", 3]);
    expect(sql).not.toContain("source-1");
  });

  it("scans past the first page so later chunks stay searchable", async () => {
    let cursorPages = 0;
    mocks.readAppRows.mockImplementation(async (sql: string) => {
      if (sql.includes("GROUP BY d.source_id")) return [{ source_id: "source-1", chunks: 2 }];
      if (!sql.includes("> (?, ?)")) return [row("first-page", null, "nothing relevant")];
      cursorPages += 1;
      if (cursorPages === 1) return [row("second-page", null, "needle in a later chunk")];
      return [];
    });
    expect(await searchDocuments("needle")).toMatchObject([
      { document_id: "doc-second-page", match: "substring" },
    ]);
    expect(cursorPages).toBe(1);
  });

  it("shares the scan budget across sources so a large source cannot starve a small one", async () => {
    mocks.rows = [
      { ...row("a-1", null, "needle a1"), source_id: "source-a" },
      { ...row("a-2", null, "needle a2"), source_id: "source-a" },
      { ...row("a-3", null, "needle a3"), source_id: "source-a" },
      { ...row("b-1", null, "needle b1"), source_id: "source-b" },
    ];
    const result = await searchDocumentsWithMeta("needle", { maxScannedRows: 2 });
    expect(result.hits.map((hit) => hit.source_id).sort()).toEqual(["source-a", "source-b"]);
    expect(result.coverage).toMatchObject({
      scanned_chunks: 2,
      total_chunks: 4,
      truncated: true,
    });
  });

  it("deduplicates identical documents by content hash while preserving distinct chunks", async () => {
    mocks.rows = [
      { ...row("dup-a", null, "needle first"), document_id: "doc-dup-a", chunk_index: 0, content_hash: "shared" },
      { ...row("dup-b", null, "needle first"), document_id: "doc-dup-b", chunk_index: 0, content_hash: "shared" },
      { ...row("dup-c", null, "needle second"), document_id: "doc-dup-c", chunk_index: 1, content_hash: "shared" },
      { ...row("unique", null, "needle unique"), content_hash: "unique" },
    ];
    const hits = await searchDocuments("needle");
    expect(hits.map((hit) => hit.document_id).sort()).toEqual([
      "doc-dup-a",
      "doc-dup-c",
      "doc-unique",
    ]);
  });

  it("executes both query forms against SQLite without returning disabled or other sources", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE document_sources (id TEXT, label TEXT, enabled INTEGER);
        CREATE TABLE documents (id TEXT, source_id TEXT, rel_path TEXT, path TEXT, chunk_count INTEGER NOT NULL DEFAULT 0, content_hash TEXT);
        CREATE TABLE document_chunks (
          id TEXT, document_id TEXT, chunk_index INTEGER, text TEXT,
          embedding TEXT, embedding_model_signature TEXT
        );
        INSERT INTO document_sources VALUES
          ('source-a', 'A', 1), ('source-b', 'B', 1), ('source-off', 'Off', 0);
        INSERT INTO documents VALUES
          ('doc-a', 'source-a', 'a.md', '/a.md', 1, 'hash-a'),
          ('doc-b', 'source-b', 'b.md', '/b.md', 1, 'hash-b'),
          ('doc-off', 'source-off', 'off.md', '/off.md', 1, 'hash-off');
        INSERT INTO document_chunks VALUES
          ('a', 'doc-a', 0, 'needle', NULL, NULL),
          ('b', 'doc-b', 0, 'needle', NULL, NULL),
          ('off', 'doc-off', 0, 'needle', NULL, NULL);
      `);
      mocks.readAppRows.mockImplementation(async (sql: string, params: unknown[] = []) => (
        db.prepare(sql).all(...params) as Array<Record<string, unknown>>
      ));
      expect((await searchDocuments("needle")).map((hit) => hit.document_id).sort())
        .toEqual(["doc-a", "doc-b"]);
      expect(await searchDocuments("needle", { sourceId: "source-b" }))
        .toMatchObject([{ document_id: "doc-b", source_label: "B", match: "substring" }]);
      expect(await searchDocuments("needle", { sourceId: "source-off" })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it.each([0, -0.5, 0.86, 0.9])("only falls back for nonpositive semantic scores: %s", async (score) => {
    mocks.rows = [row("score-boundary", score, "needle literal")];
    const hits = await searchDocuments("needle");
    if (score <= 0) {
      expect(hits).toMatchObject([{ score: 0.6, match: "substring" }]);
    } else if (score <= 0.86) {
      expect(hits).toEqual([]);
    } else {
      expect(hits).toMatchObject([{ score, match: "semantic" }]);
    }
  });

  it("uses substring matching without a query embedding", async () => {
    mocks.embedQueryOne.mockResolvedValue(null);
    mocks.rows = [row("no-query-vector", 0.9, "needle literal")];
    expect(await searchDocuments("needle")).toMatchObject([{ score: 0.6, match: "substring" }]);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("falls back and queues one reindex per mismatched document", async () => {
    const document_id = "synthetic-mismatched-search-doc";
    mocks.rows = [
      { ...row("mismatch-a", null, "needle first"), document_id, chunk_index: 0, embedding: "[1,0,0]" },
      { ...row("mismatch-b", null, "needle second"), document_id, chunk_index: 1, embedding: "[1]" },
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await searchDocuments("needle")).toMatchObject([
        { score: 0.6, match: "substring" }, { score: 0.6, match: "substring" },
      ]);
      expect(mocks.run).toHaveBeenCalledExactlyOnceWith(document_id);
      await searchDocuments("needle");
      expect(mocks.run).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it("does not queue repairs or return partial results when topic validation fails", async () => {
    mocks.recallPolicy.mockReturnValue({ ...defaultDocumentRecallPolicy(), topics: ["private topic"] });
    mocks.rows = [{ ...row("blocked-mismatch", null, "needle"), embedding: "[1,0,0]" }];
    await expect(searchDocuments("needle")).rejects.toThrow("Document search blocked");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("scores float32 BLOB and legacy JSON embeddings identically", async () => {
    mocks.rows = [
      { ...row("blob", 0.9, "needle blob"), embedding: encodeEmbedding([0.9, 0.1]) },
      { ...row("legacy", 0.87, "needle legacy"), embedding: JSON.stringify([0.87, 0.13]) },
    ];

    const hits = await searchDocuments("needle");

    expect(hits).toMatchObject([
      { document_id: "doc-blob", match: "semantic" },
      { document_id: "doc-legacy", match: "semantic" },
    ]);
    expect(hits[0].score).toBeCloseTo(0.9);
    expect(hits[1].score).toBeCloseTo(0.87);
  });

  it("reports complete coverage when the scan reaches the end", async () => {
    const result = await searchDocumentsWithMeta("needle");
    expect(result.coverage).toEqual({
      scanned_chunks: 3, total_chunks: 3, truncated: false, max_scanned_rows: 20_000,
    });
    expect(result.hits.map((hit) => hit.document_id)).toEqual(["doc-high", "doc-literal"]);
  });

  it("reports a capped scan as truncated instead of complete", async () => {
    const result = await searchDocumentsWithMeta("needle", { maxScannedRows: 2 });
    expect(result.coverage).toEqual({
      scanned_chunks: 2, total_chunks: 3, truncated: true, max_scanned_rows: 2,
    });
  });

  it("returns empty coverage for an empty query without scanning", async () => {
    expect(await searchDocumentsWithMeta("   ")).toEqual({
      hits: [],
      coverage: { scanned_chunks: 0, total_chunks: 0, truncated: false, max_scanned_rows: 20_000 },
    });
    expect(mocks.readAppRows).not.toHaveBeenCalled();
  });
});