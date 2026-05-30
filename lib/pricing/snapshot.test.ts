import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.fn();
const mkdirMock = vi.fn();
const writeFileMock = vi.fn();

vi.mock("node:fs/promises", () => ({
  readFile: readFileMock,
  mkdir: mkdirMock,
  writeFile: writeFileMock,
}));

describe("pricing snapshot refresh", () => {
  beforeEach(() => {
    vi.resetModules();
    readFileMock.mockReset();
    mkdirMock.mockReset();
    writeFileMock.mockReset();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes and writes snapshot when cache is missing", async () => {
    readFileMock.mockRejectedValueOnce(new Error("ENOENT"));

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => "<html>input $1.00 / 1M tokens output $2.00 / 1M tokens</html>",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { refreshPricingSnapshot } = await import("./snapshot");
    const res = await refreshPricingSnapshot({ force: true, ttlDays: 2 });

    expect(res.refreshed).toBe(true);
    expect(res.reason).toBe("forced");
    expect(res.snapshot.sources.length).toBeGreaterThan(0);
    expect(res.snapshot.ttl_days).toBe(2);
    expect(fetchMock).toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });

  it("returns fresh cache without fetching when snapshot is within ttl", async () => {
    const fresh = {
      generated_at: new Date().toISOString(),
      disclaimer: "cached",
      ttl_days: 3,
      sources: [],
    };
    readFileMock.mockResolvedValueOnce(JSON.stringify(fresh));

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { refreshPricingSnapshot } = await import("./snapshot");
    const res = await refreshPricingSnapshot({ force: false, ttlDays: 3 });

    expect(res.refreshed).toBe(false);
    expect(res.reason).toBe("fresh");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});
