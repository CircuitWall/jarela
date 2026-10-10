import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  embedQueryOne: vi.fn(),
  localEmbeddingsEnabled: vi.fn(() => true),
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ prepare: () => ({ all: () => mocks.rows }) }),
}));
vi.mock("@/lib/embeddings", () => ({
  embedQueryOne: mocks.embedQueryOne,
  processMessageEmbeddingJobs: vi.fn(async () => 0),
  cosine: (_query: number[], vector: number[]) => vector[0],
}));
vi.mock("@/lib/stores/app-settings", () => ({ isLocalEmbeddingsEnabled: mocks.localEmbeddingsEnabled }));

const { searchDocuments } = await import("./search");

function row(id: string, score: number | null, text: string) {
  return {
    chunk_id: id,
    document_id: `doc-${id}`,
    chunk_index: 0,
    text,
    embedding: score === null ? null : JSON.stringify([score, 1 - score]),
    source_id: "source-1",
    source_label: "Docs",
    rel_path: `${id}.md`,
    abs_path: `/${id}.md`,
  };
}

describe("searchDocuments similarity threshold", () => {
  beforeEach(() => {
    mocks.localEmbeddingsEnabled.mockReturnValue(true);
    mocks.embedQueryOne.mockReset().mockResolvedValue([1, 0]);
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
});