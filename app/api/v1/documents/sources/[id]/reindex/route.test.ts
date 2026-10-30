import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  source: vi.fn(), run: vi.fn(), clear: vi.fn(), backfill: vi.fn(),
}));
vi.mock("@/lib/stores/document-sources", () => ({ getDocumentSource: mocks.source }));
vi.mock("@/lib/documents/indexer", () => ({
  clearSourceEmbeddings: mocks.clear, backfillSourceEmbeddings: mocks.backfill, indexSource: vi.fn(),
}));
vi.mock("@/lib/documents/remote", () => ({ isRemoteKind: () => true, runRemoteSource: mocks.run }));
import { POST } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.source.mockReturnValue({ id: "synthetic", kind: "icloud_mail" });
  mocks.backfill.mockResolvedValue({ failed: 0, error: null });
});

describe("mail reindex failures", () => {
  it("preserves the legacy not-found response", async () => {
    mocks.source.mockReturnValue(null);
    const response = await POST(new NextRequest("http://localhost/api/v1/documents/sources/missing/reindex", { method: "POST" }), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("preserves unexpected scan failures as HTTP 500", async () => {
    mocks.run.mockRejectedValue(new Error("synthetic scan failure"));
    const response = await POST(new NextRequest("http://localhost/api/v1/documents/sources/synthetic/reindex", { method: "POST" }), {
      params: Promise.resolve({ id: "synthetic" }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "synthetic scan failure" });
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.backfill).not.toHaveBeenCalled();
  });

  it.each([
    "iCloud indexing requires an updated package.",
    "Outlook search reached Microsoft's 1,000-result ceiling.",
  ])("does not report a failed scan as successful: %s", async (error) => {
    mocks.run.mockResolvedValue({ scanned: 0, added: 0, updated: 0, unchanged: 0, errors: 1, error });
    const response = await POST(new NextRequest("http://localhost/api/v1/documents/sources/synthetic/reindex", { method: "POST" }), {
      params: Promise.resolve({ id: "synthetic" }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error });
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.backfill).not.toHaveBeenCalled();
  });

  it("backfills successful archive scans normally", async () => {
    mocks.run.mockResolvedValue({ scanned: 2, added: 1, updated: 0, unchanged: 1, errors: 0 });
    const response = await POST(new NextRequest("http://localhost/api/v1/documents/sources/synthetic/reindex", { method: "POST" }), {
      params: Promise.resolve({ id: "synthetic" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.clear).toHaveBeenCalledWith("synthetic");
    expect(mocks.backfill).toHaveBeenCalledWith("synthetic");
  });
});
