import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultDocumentRecallPolicy } from "./recall-policy";

const mocks = vi.hoisted(() => ({
  embedQueryOne: vi.fn(),
  embedQueryWithSignature: vi.fn(),
  localEmbeddingsEnabled: vi.fn(() => true),
  rows: [] as Array<Record<string, unknown>>,
  recallPolicy: vi.fn(),
  cosine: vi.fn((_query: number[], vector: number[]) => vector[0]),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ prepare: () => ({ all: () => mocks.rows }) }),
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

const { searchDocuments } = await import("./search");

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
  };
}

describe("searchDocuments similarity threshold", () => {
  beforeEach(() => {
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
});