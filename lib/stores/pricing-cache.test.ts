import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ statSync: vi.fn(), readFileSync: vi.fn() }));
vi.mock("node:fs", () => mocks);
vi.mock("./known-rates", () => ({ knownRateModelIds: () => [], knownRateFor: () => null }));
const { getPricingTables } = await import("./pricing");

describe("pricing snapshot read cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not read or parse the snapshot again when its mtime is unchanged", () => {
    mocks.statSync.mockReturnValue({ mtimeMs: 100 });
    mocks.readFileSync.mockReturnValue(JSON.stringify({ generated_at: "first", sources: [] }));
    const first = getPricingTables();
    expect(getPricingTables()).toBe(first);
    expect(mocks.statSync).toHaveBeenCalledTimes(2);
    expect(mocks.readFileSync).toHaveBeenCalledTimes(1);
  });

  it("reloads rates when the snapshot changes", () => {
    mocks.statSync.mockReturnValue({ mtimeMs: 200 });
    mocks.readFileSync.mockReturnValue(JSON.stringify({ generated_at: "second", sources: [] }));
    expect(getPricingTables().generatedAt).toBe("second");
    mocks.statSync.mockReturnValue({ mtimeMs: 300 });
    mocks.readFileSync.mockReturnValue(JSON.stringify({ generated_at: "third", sources: [] }));
    expect(getPricingTables().generatedAt).toBe("third");
    expect(mocks.readFileSync).toHaveBeenCalledTimes(2);
  });
});
