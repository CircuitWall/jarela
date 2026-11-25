import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: mocks.read }));

import { getCurrentVersion } from "./version";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("current package version", () => {
  it("reads the package version from the bundle root", () => {
    mocks.read.mockReturnValue('{"version":"3.2.0"}');
    expect(getCurrentVersion()).toBe("3.2.0");
    expect(mocks.read).toHaveBeenCalledWith(join(process.cwd(), "package.json"), "utf8");
  });

  it.each(["{}", "{", "null", '{"version":null}'])("preserves the existing unknown-version sentinel for %s", (raw) => {
    mocks.read.mockReturnValue(raw);
    expect(getCurrentVersion()).toBe("0.0.0");
  });

  it("preserves the unknown-version sentinel on a missing package file", () => {
    mocks.read.mockImplementation(() => { throw new Error("Synthetic missing file"); });
    expect(getCurrentVersion()).toBe("0.0.0");
  });
});
