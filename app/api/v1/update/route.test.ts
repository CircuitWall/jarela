import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn(), check: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: mocks.read }));
vi.mock("@/lib/lifecycle/update-check", () => ({ checkForUpdate: mocks.check }));

import { GET } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.check.mockResolvedValue({ current: "3.2.0", update_available: false });
});

describe("GET /api/v1/update", () => {
  it("returns the update check built from the bundle-root version", async () => {
    mocks.read.mockReturnValue('{"version":"3.2.0"}');
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ current: "3.2.0", update_available: false });
    expect(mocks.check).toHaveBeenCalledExactlyOnceWith({ current: "3.2.0", packageRoot: process.cwd() });
  });

  it("passes the unknown-version sentinel through to the update check", async () => {
    mocks.read.mockReturnValue("{}");
    await GET();
    expect(mocks.check).toHaveBeenCalledWith({ current: "0.0.0", packageRoot: process.cwd() });
  });

  it("keeps the sentinel when the package file is missing", async () => {
    mocks.read.mockImplementation(() => { throw new Error("Synthetic missing file"); });
    await GET();
    expect(mocks.check).toHaveBeenCalledWith({ current: "0.0.0", packageRoot: process.cwd() });
  });
});
