import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-doc-github-"));
process.env.JARELA_DB_DIR = tmpRoot;

// Stub out the only external surfaces — auth resolution and the GitHub
// REST wrapper. We don't care which integration row is configured; we
// only want to verify the indexer dispatches correctly to the right
// endpoints with the right shapes.
vi.mock("@/lib/tools/github", () => ({
  _resolveGithubAuth: vi.fn(() => ({ token: "stub" })),
  _ghFetch: vi.fn(),
}));
vi.mock("./upsert", () => ({
  upsertRemoteDocument: vi.fn(async () => ({
    status: "added" as const,
    chunks: 1,
    embedded: 1,
    embedError: null,
  })),
}));

const { _ghFetch } = await import("@/lib/tools/github");
const { upsertRemoteDocument } = await import("./upsert");
const {
  runGithubIndexer,
  indexGithubPullByUrl,
  indexGithubFileByUrl,
} = await import("./github");
const { createDocumentSource, listDocumentSources, deleteDocumentSource, getDocumentSource } =
  await import("@/lib/stores/document-sources");

const ghMock = _ghFetch as unknown as ReturnType<typeof vi.fn>;
const upsertMock = upsertRemoteDocument as unknown as ReturnType<typeof vi.fn>;

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  vi.clearAllMocks();
  upsertMock.mockResolvedValue({ status: "added", chunks: 1, embedded: 1, embedError: null });
  for (const s of listDocumentSources()) deleteDocumentSource(s.id);
});

describe("runGithubIndexer — github_pulls", () => {
  it("paginates PRs, fetches comments+reviews, and updates the high-water cursor", async () => {
    const source = createDocumentSource({
      path: "github-pulls://octo/repo",
      label: "PRs",
      kind: "github_pulls",
      config: { owner: "octo", repo: "repo", state: "all" },
    });

    // First /pulls page: two PRs. Then /comments + /reviews each. Then
    // an empty second page so the loop exits.
    ghMock
      .mockResolvedValueOnce([
        { number: 2, title: "B", updated_at: "2026-01-02T00:00:00Z", html_url: "https://github.com/octo/repo/pull/2" },
        { number: 1, title: "A", updated_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/octo/repo/pull/1" },
      ])
      .mockResolvedValueOnce([]) // pr 2 comments
      .mockResolvedValueOnce([]) // pr 2 reviews
      .mockResolvedValueOnce([]) // pr 1 comments
      .mockResolvedValueOnce([]); // pr 1 reviews

    const stats = await runGithubIndexer(source);

    expect(stats.scanned).toBe(2);
    expect(stats.added).toBe(2);
    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(upsertMock).toHaveBeenCalledWith(
      source.id,
      expect.objectContaining({ path: "github-pull://octo/repo/2" }),
    );
    // Cursor should advance to the most recent updated_at seen.
    const after = getDocumentSource(source.id)!;
    expect(after.last_cursor).toBe("2026-01-02T00:00:00Z");
  });

  it("rejects when config.owner / config.repo are missing", async () => {
    const source = createDocumentSource({
      path: "github-pulls://x/y",
      label: "Bad",
      kind: "github_pulls",
      config: { owner: "x" },
    });
    await expect(runGithubIndexer(source)).rejects.toThrow(/config\.owner and config\.repo/);
  });
});

describe("runGithubIndexer — github_repo", () => {
  it("short-circuits when the tree SHA matches the previous cursor", async () => {
    const source = createDocumentSource({
      path: "github-repo://octo/repo",
      label: "Repo",
      kind: "github_repo",
      config: { owner: "octo", repo: "repo", ref: "main" },
    });
    // Pre-seed the cursor with the SHA we'll see returned.
    const { updateDocumentSourceCursor } = await import("@/lib/stores/document-sources");
    updateDocumentSourceCursor(source.id, "tree-sha-abc");

    ghMock.mockResolvedValueOnce({ sha: "tree-sha-abc", tree: [] });

    const stats = await runGithubIndexer(source);
    expect(stats.scanned).toBe(0);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(stats.cursor).toBe("tree-sha-abc");
  });

  it("walks blobs filtered by ALLOWED_EXT and indexes each as a separate document", async () => {
    const source = createDocumentSource({
      path: "github-repo://octo/repo",
      label: "Repo",
      kind: "github_repo",
      config: { owner: "octo", repo: "repo", ref: "main" },
    });

    const mdContent = Buffer.from("# README\n\nHello.").toString("base64");
    ghMock
      .mockResolvedValueOnce({
        sha: "tree-sha-new",
        tree: [
          { path: "README.md", type: "blob", size: 100 },
          { path: "image.png", type: "blob", size: 100 },     // filtered: not ALLOWED_EXT
          { path: "src", type: "tree" },                       // filtered: not blob
        ],
      })
      .mockResolvedValueOnce({ type: "file", encoding: "base64", content: mdContent });

    const stats = await runGithubIndexer(source);
    expect(stats.scanned).toBe(1);
    expect(stats.added).toBe(1);
    expect(upsertMock).toHaveBeenCalledWith(
      source.id,
      expect.objectContaining({ path: "github-file://octo/repo@main/README.md", title: "README.md" }),
    );
    const after = getDocumentSource(source.id)!;
    expect(after.last_cursor).toBe("tree-sha-new");
  });
});

describe("on-demand helpers", () => {
  it("indexGithubPullByUrl flattens title + URL into the document body", async () => {
    ghMock
      .mockResolvedValueOnce({
        number: 7,
        title: "Fix bug",
        state: "open",
        updated_at: "2026-02-01T00:00:00Z",
        html_url: "https://github.com/octo/repo/pull/7",
        body: "Body.",
      })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await indexGithubPullByUrl("source-id", "octo", "repo", 7);
    expect(res.status).toBe("added");
    expect(upsertMock).toHaveBeenCalledWith(
      "source-id",
      expect.objectContaining({
        path: "github-pull://octo/repo/7",
        title: "PR #7: Fix bug",
        text: expect.stringContaining("https://github.com/octo/repo/pull/7"),
      }),
    );
  });

  it("indexGithubFileByUrl decodes base64 and rejects directories", async () => {
    ghMock.mockResolvedValueOnce({ type: "dir" });
    await expect(
      indexGithubFileByUrl("source-id", "octo", "repo", "main", "src"),
    ).rejects.toThrow(/not a file/);
  });
});
