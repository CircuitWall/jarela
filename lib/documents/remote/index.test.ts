import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-doc-ondemand-"));
process.env.JARELA_DB_DIR = tmpRoot;

// Mock the per-kind handlers so we don't make real HTTP calls — we just
// verify the input parser dispatches to the right one with the right key.
vi.mock("./jira", () => ({
  indexJiraIssueByKey: vi.fn(async () => ({ status: "added" as const })),
  runJiraIndexer: vi.fn(),
}));
vi.mock("./confluence", () => ({
  indexConfluencePageById: vi.fn(async () => ({ status: "added" as const })),
  runConfluenceIndexer: vi.fn(),
}));
vi.mock("./github", () => ({
  indexGithubPullByUrl: vi.fn(async () => ({ status: "added" as const })),
  indexGithubIssueByUrl: vi.fn(async () => ({ status: "added" as const })),
  indexGithubFileByUrl: vi.fn(async () => ({ status: "added" as const })),
  runGithubIndexer: vi.fn(),
}));

const { indexJiraIssueByKey } = await import("./jira");
const { indexConfluencePageById } = await import("./confluence");
const { indexGithubPullByUrl, indexGithubIssueByUrl, indexGithubFileByUrl } = await import("./github");
const { indexOnDemand, getOrCreateOnDemandSource } = await import("./index");
const { deleteDocumentSource, listDocumentSources } = await import("@/lib/stores/document-sources");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("indexOnDemand input parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const s of listDocumentSources()) deleteDocumentSource(s.id);
  });

  it("recognises a bare Jira key", async () => {
    const r = await indexOnDemand("ABC-123");
    expect(r.kind).toBe("jira");
    expect(r.identifier).toBe("ABC-123");
    expect(indexJiraIssueByKey).toHaveBeenCalledWith(expect.any(String), "ABC-123");
  });

  it("recognises a /browse/<KEY> URL", async () => {
    const r = await indexOnDemand("https://acme.atlassian.net/browse/PROJ-42");
    expect(r.kind).toBe("jira");
    expect(r.identifier).toBe("PROJ-42");
  });

  it("recognises a /wiki/spaces/.../pages/<id> URL", async () => {
    const r = await indexOnDemand(
      "https://acme.atlassian.net/wiki/spaces/ENG/pages/12345/Runbook",
    );
    expect(r.kind).toBe("confluence");
    expect(r.identifier).toBe("12345");
    expect(indexConfluencePageById).toHaveBeenCalledWith(expect.any(String), "12345");
  });

  it("recognises a ?pageId=<id> URL", async () => {
    const r = await indexOnDemand("https://acme.atlassian.net/wiki/viewpage.action?pageId=99");
    expect(r.kind).toBe("confluence");
    expect(r.identifier).toBe("99");
  });

  it("recognises a GitHub /pull/<n> URL", async () => {
    const r = await indexOnDemand("https://github.com/octocat/hello-world/pull/42");
    expect(r.kind).toBe("github");
    expect(r.identifier).toBe("octocat/hello-world#42");
    expect(indexGithubPullByUrl).toHaveBeenCalledWith(expect.any(String), "octocat", "hello-world", 42);
  });

  it("recognises a GitHub /issues/<n> URL", async () => {
    const r = await indexOnDemand("https://github.com/octocat/hello-world/issues/7");
    expect(r.kind).toBe("github");
    expect(r.identifier).toBe("octocat/hello-world#7");
    expect(indexGithubIssueByUrl).toHaveBeenCalledWith(expect.any(String), "octocat", "hello-world", 7);
  });

  it("recognises a GitHub /blob/<ref>/<path> URL and strips fragments", async () => {
    const r = await indexOnDemand(
      "https://github.com/octocat/hello-world/blob/main/docs/setup.md?plain=1#L4",
    );
    expect(r.kind).toBe("github");
    expect(r.identifier).toBe("octocat/hello-world@main/docs/setup.md");
    expect(indexGithubFileByUrl).toHaveBeenCalledWith(
      expect.any(String), "octocat", "hello-world", "main", "docs/setup.md",
    );
  });

  it("throws on unrecognised input", async () => {
    await expect(indexOnDemand("https://example.com/random")).rejects.toThrow(/could not recognise/);
  });

  it("reuses a single 'on_demand_url' source row", async () => {
    const a = getOrCreateOnDemandSource();
    const b = getOrCreateOnDemandSource();
    expect(a.id).toBe(b.id);
    expect(a.kind).toBe("on_demand_url");
  });
});
