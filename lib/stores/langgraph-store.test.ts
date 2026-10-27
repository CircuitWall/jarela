import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({
  getMemory: vi.fn(),
  listMemory: vi.fn(),
  putMemory: vi.fn(),
  deleteMemory: vi.fn(),
}));

vi.mock("@/lib/stores/memory", () => memory);

import { SqliteMemoryStore } from "./langgraph-store";
import { getMemory, listMemory } from "@/lib/stores/memory";

describe("SqliteMemoryStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the same raw-value fallback for get and search results", async () => {
    getMemory.mockReturnValue({
      namespace: "facts",
      key: "legacy",
      value: "not-json",
      created_at: "2026-10-27T00:00:00.000Z",
      updated_at: "2026-10-27T00:00:00.000Z",
    });
    listMemory.mockReturnValue([{
      namespace: "facts",
      key: "current",
      value: "{\"answer\":42}",
      created_at: "2026-10-27T00:00:00.000Z",
      updated_at: "2026-10-27T00:00:00.000Z",
    }, {
      namespace: "facts",
      key: "legacy",
      value: "not-json",
      created_at: "2026-10-27T00:00:00.000Z",
      updated_at: "2026-10-27T00:00:00.000Z",
    }]);

    const results = await new SqliteMemoryStore().batch([
      { namespace: ["facts"], key: "legacy" },
      { namespacePrefix: ["facts"], limit: 10 },
    ]);

    expect(results[0]).toMatchObject({ value: { _raw: "not-json" } });
    expect(results[1]).toMatchObject([
      { value: { answer: 42 } },
      { value: { _raw: "not-json" } },
    ]);
  });
});
