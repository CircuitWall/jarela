import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-doc-tools-"));
process.env.JARELA_DB_DIR = join(tmpRoot, "db");

const searchMocks = vi.hoisted(() => ({ searchDocuments: vi.fn() }));
vi.mock("@/lib/documents/search", () => searchMocks);

const { documentsAddLocalSource, documentsListSources, documentsSearch } = await import("./documents");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("documents_add_local_source", () => {
  let sourceDir: string;

  beforeAll(() => {
    sourceDir = join(tmpRoot, "workspace-docs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "README.md"), "hello");
  });

  it("adds a valid local directory source", async () => {
    const out = JSON.parse(await documentsAddLocalSource.invoke({
      path: sourceDir,
      label: "Docs",
    })) as { ok?: boolean; id?: string; kind?: string; path?: string };

    expect(out.ok).toBe(true);
    expect(out.id).toBeTruthy();
    expect(out.kind).toBe("local_folder");
    expect(out.path).toBe(sourceDir);

    const listed = JSON.parse(await documentsListSources.invoke({})) as {
      sources: Array<{ id: string; path: string; label: string | null }>;
    };
    expect(listed.sources.some((s) => s.path === sourceDir && s.label === "Docs")).toBe(true);
  });

  it("rejects duplicate paths", async () => {
    const out = JSON.parse(await documentsAddLocalSource.invoke({
      path: sourceDir,
      label: "Docs again",
    })) as { error?: string };

    expect(out.error).toContain("already exists");
  });

  it("rejects non-directory paths", async () => {
    const filePath = join(tmpRoot, "not-a-dir.txt");
    writeFileSync(filePath, "x");

    const out = JSON.parse(await documentsAddLocalSource.invoke({
      path: filePath,
      label: "bad",
    })) as { error?: string };

    expect(out.error).toBe("path is not a directory");
  });

  it("explains invalid source_id filters before searching", async () => {
    const out = JSON.parse(await documentsSearch.invoke({
      query: "hello",
      source_id: "missing-source",
    })) as { error?: string; error_code?: string; available_sources?: Array<{ id: string }>; recovery_hint?: string };

    expect(out.error_code).toBe("source_not_found");
    expect(out.error).toContain("missing-source");
    expect(out.available_sources?.length).toBeGreaterThan(0);
    expect(out.recovery_hint).toContain("documents_list_sources");
  });

  it("groups agent results by file and caps passages and excerpt size", async () => {
    const text = "x".repeat(1_500);
    searchMocks.searchDocuments.mockResolvedValue([
      { document_id: "doc-a", source_id: "source-a", source_label: "Docs", rel_path: "guide.md", abs_path: "", chunk_index: 0, text, score: 0.9, match: "semantic" },
      { document_id: "doc-a", source_id: "source-a", source_label: "Docs", rel_path: "guide.md", abs_path: "", chunk_index: 1, text: "second passage", score: 0.8, match: "semantic" },
      { document_id: "doc-a", source_id: "source-a", source_label: "Docs", rel_path: "guide.md", abs_path: "", chunk_index: 2, text: "third passage", score: 0.7, match: "substring" },
      { document_id: "doc-b", source_id: "source-b", source_label: null, rel_path: "notes.txt", abs_path: "", chunk_index: 0, text: "other file", score: 0.6, match: "semantic" },
    ]);

    const out = JSON.parse(await documentsSearch.invoke({ query: "term", limit: 2 })) as {
      hits: Array<{ path: string; passages: Array<{ chunk_index: number; text: string }> }>;
    };

    expect(searchMocks.searchDocuments).toHaveBeenCalledWith("term", { limit: 10, sourceId: undefined, minSimilarity: undefined });
    expect(out.hits).toHaveLength(2);
    expect(out.hits[0].path).toBe("guide.md");
    expect(out.hits[0].passages.map((passage) => passage.chunk_index)).toEqual([0, 1]);
    expect(out.hits[0].passages[0].text).toHaveLength(1_200);
    expect(out.hits[1].path).toBe("notes.txt");
  });
});
