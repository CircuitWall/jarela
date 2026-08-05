import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

import { execSync } from "node:child_process";

const mockedExecSync = vi.mocked(execSync);

describe("resolveSubprocessEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/bin",
    };
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue("/opt/homebrew/bin:/usr/bin:/bin\n");
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("probes the user's interactive shell path and merges it into subprocess env", async () => {
    const { resolveSubprocessEnv } = await import("./subprocess-env");

    const result = resolveSubprocessEnv({ cwd: "/tmp" });

    expect(mockedExecSync).toHaveBeenCalledWith(
      "/bin/zsh -ic 'echo $PATH'",
      expect.objectContaining({
        encoding: "utf8",
        timeout: 4_000,
      }),
    );
    expect(result.cwd).toBe("/tmp");
    expect(result.env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });
});