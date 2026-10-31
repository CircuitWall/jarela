import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ read: vi.fn(), check: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: mocks.read }));
vi.mock("@/lib/lifecycle/update-check", () => ({ checkForUpdate: mocks.check }));

import { getCurrentVersion } from "./version";
import { GET } from "@/app/api/v1/update/route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.check.mockResolvedValue({ current: "3.2.0", update_available: false });
});

describe("current package version", () => {
  it("shares the bundle-root lookup with the update route", async () => {
    mocks.read.mockReturnValue('{"version":"3.2.0"}');
    expect(getCurrentVersion()).toBe("3.2.0");
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ current: "3.2.0", update_available: false });
    expect(mocks.read).toHaveBeenCalledWith(join(process.cwd(), "package.json"), "utf8");
    expect(mocks.check).toHaveBeenCalledExactlyOnceWith({ current: "3.2.0", packageRoot: process.cwd() });
  });

  it.each(["{}", "{", "null", '{"version":null}'])("preserves the existing unknown-version sentinel for %s", (raw) => {
    mocks.read.mockReturnValue(raw);
    expect(getCurrentVersion()).toBe("0.0.0");
  });

  it("preserves the unknown-version sentinel on a missing package file", async () => {
    mocks.read.mockImplementation(() => { throw new Error("Synthetic missing file"); });
    expect(getCurrentVersion()).toBe("0.0.0");
    await GET();
    expect(mocks.check).toHaveBeenCalledWith({ current: "0.0.0", packageRoot: process.cwd() });
  });
});
