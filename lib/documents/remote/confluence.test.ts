import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  atlassianFetch: vi.fn(),
  updateDocumentSourceCursor: vi.fn(),
  upsertRemoteDocument: vi.fn(),
}));

vi.mock("@/lib/tools/runtime/auth-registry", () => ({
  resolvePackageAuth: () => ({
    url: "https://example.atlassian.net",
    email: "test@example.com",
    apiToken: "test-token",
  }),
}));
vi.mock("@/lib/tools/packages/optional-package", () => ({
  optionalFunction: () => (...args: unknown[]) => mocks.atlassianFetch(...args),
}));
vi.mock("@/lib/stores/document-sources", () => ({
  parseSourceConfig: (source: { config?: unknown }) => source.config,
  updateDocumentSourceCursor: mocks.updateDocumentSourceCursor,
}));
vi.mock("./upsert", () => ({
  upsertRemoteDocument: mocks.upsertRemoteDocument,
}));

import { runConfluenceIndexer } from "./confluence";

describe("runConfluenceIndexer pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsertRemoteDocument.mockResolvedValue({
      status: "added", chunks: 1, embedded: 1, embedError: null,
    });
  });

  it("uses the documented search endpoint and follows its next cursor", async () => {
    mocks.atlassianFetch
      .mockResolvedValueOnce({
        results: [{ content: { id: "page-1", title: "First", version: { when: "2026-01-01T00:00:00Z" } } }],
        _links: { next: "/wiki/rest/api/search?cursor=next%2Fpage" },
      })
      .mockResolvedValueOnce({
        results: [{ content: { id: "page-2", title: "Second", version: { when: "2026-01-02T00:00:00Z" } } }],
      });

    const result = await runConfluenceIndexer({
      id: "source-1",
      kind: "confluence_space",
      config: { space_key: "ENG" },
      last_cursor: null,
    } as never);

    expect(mocks.atlassianFetch).toHaveBeenCalledTimes(2);
    const firstPath = mocks.atlassianFetch.mock.calls[0][1] as string;
    const secondPath = mocks.atlassianFetch.mock.calls[1][1] as string;
    expect(firstPath).toContain("/wiki/rest/api/search?");
    expect(new URLSearchParams(firstPath.split("?")[1]).get("expand")).toBe(
      "content.body.storage,content.version,content.history.lastUpdated",
    );
    expect(new URLSearchParams(secondPath.split("?")[1]).get("cursor")).toBe("next/page");
    expect(result.scanned).toBe(2);
    expect(mocks.updateDocumentSourceCursor).toHaveBeenCalledWith("source-1", "2026-01-02T00:00:00Z");
  });
});