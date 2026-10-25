import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const search = vi.hoisted(() => vi.fn());
vi.mock("@/lib/documents/search", () => ({
  searchDocuments: search,
  getDefaultDocumentMinSimilarity: () => 0.86,
}));
const { GET } = await import("./route");
const { DocumentExclusionUnavailableError } = await import("@/lib/documents/recall-policy");
beforeEach(() => { search.mockReset().mockResolvedValue([]); });

describe("document search preview exclusions", () => {
  it("does not bypass exclusions by default", async () => {
    await GET(new NextRequest("http://localhost/api/v1/documents/search?q=notes"));
    expect(search).toHaveBeenCalledWith("notes", expect.objectContaining({ includeExcluded: false }));
  });

  it("accepts the explicit preview override", async () => {
    await GET(new NextRequest("http://localhost/api/v1/documents/search?q=notes&include_excluded=true"));
    expect(search).toHaveBeenCalledWith("notes", expect.objectContaining({ includeExcluded: true }));
  });

  it("rejects ambiguous override values", async () => {
    const response = await GET(new NextRequest("http://localhost/api/v1/documents/search?q=notes&include_excluded=1"));
    expect(response.status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it("returns an actionable failure instead of unchecked content", async () => {
    search.mockRejectedValue(new DocumentExclusionUnavailableError());
    const response = await GET(new NextRequest("http://localhost/api/v1/documents/search?q=notes"));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("Document search blocked");
  });
});
