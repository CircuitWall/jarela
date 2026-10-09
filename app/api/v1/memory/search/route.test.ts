import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ searchMemory: vi.fn(), getDefaultChatMinSimilarity: vi.fn(() => 0.84) }));
vi.mock("@/lib/embeddings", () => mocks);

const { GET } = await import("./route");

describe("GET /api/v1/memory/search", () => {
  it("searches chat history with its calibrated default threshold", async () => {
    mocks.searchMemory.mockResolvedValue([]);
    const req = new NextRequest("http://localhost/api/v1/memory/search?q=deploy&source=messages");

    const response = await GET(req);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ query: "deploy", source: "messages", hits: [], min_chat_similarity: 0.84 });
    expect(mocks.searchMemory).toHaveBeenCalledWith("deploy", {
      sources: "messages",
      limit: 10,
      literal: true,
      minSimilarity: undefined,
      minMessageSimilarity: 0.84,
    });
  });

  it("accepts a lower chat threshold and rejects out-of-range values", async () => {
    const lower = new NextRequest("http://localhost/api/v1/memory/search?q=deploy&source=messages&min_chat_similarity=0.2");
    expect((await GET(lower)).status).toBe(200);
    expect(mocks.searchMemory).toHaveBeenLastCalledWith("deploy", expect.objectContaining({ minMessageSimilarity: 0.2 }));

    const invalid = new NextRequest("http://localhost/api/v1/memory/search?q=deploy&min_chat_similarity=2");
    expect((await GET(invalid)).status).toBe(400);
  });
});