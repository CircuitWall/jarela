import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

vi.mock("@/lib/env/allowlist", () => ({
  getInjectedSubprocessEnv: vi.fn(() => ({})),
}));

import { spawnSync } from "node:child_process";
import { getInjectedSubprocessEnv } from "@/lib/env/allowlist";

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedGetInjectedSubprocessEnv = vi.mocked(getInjectedSubprocessEnv);

function mockSpawnOk(stdout: string) {
  mockedSpawnSync.mockReturnValue({
    stdout,
    stderr: "",
    status: 0,
    signal: null,
    error: undefined,
    pid: 1234,
    output: [null, stdout, ""],
  } as ReturnType<typeof spawnSync>);
}

describe("resolveSubprocessEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/bin",
    };
    mockedSpawnSync.mockReset();
    mockSpawnOk("/opt/homebrew/bin:/usr/bin:/bin\n");
    mockedGetInjectedSubprocessEnv.mockReset();
    mockedGetInjectedSubprocessEnv.mockReturnValue({});
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it.skipIf(process.platform === "win32")("probes the user's interactive shell path and merges it into subprocess env", async () => {
    const { resolveSubprocessEnv } = await import("./subprocess-env");

    const result = resolveSubprocessEnv({ cwd: "/tmp" });

    // Shell is passed as the executable argument — NOT interpolated into a string.
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-ic", "echo $PATH"],
      expect.objectContaining({
        encoding: "utf8",
        timeout: 4_000,
      }),
    );
    expect(result.cwd).toBe("/tmp");
    expect(result.env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });

  it.skipIf(process.platform === "win32")("passes SHELL value with metacharacters as the executable — not interpreted by a shell", async () => {
    process.env.SHELL = "/bin/sh; echo injected";
    mockedSpawnSync.mockReturnValue({
      stdout: "",
      stderr: "",
      status: 1,
      signal: null,
      error: undefined,
      pid: 0,
      output: [null, "", ""],
    } as ReturnType<typeof spawnSync>);
    vi.resetModules();

    const { resolveSubprocessEnv } = await import("./subprocess-env");
    resolveSubprocessEnv({ cwd: "/tmp" });

    // The whole string "/bin/sh; echo injected" must appear as the first arg
    // to spawnSync, not as part of a shell-evaluated command string.
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "/bin/sh; echo injected",
      ["-ic", "echo $PATH"],
      expect.any(Object),
    );
  });

  it.skipIf(process.platform === "win32")("falls back to process.env.PATH when spawnSync errors", async () => {
    mockedSpawnSync.mockReturnValue({
      stdout: null,
      stderr: "",
      status: null,
      signal: "SIGKILL",
      error: new Error("spawn failed"),
      pid: 0,
      output: [null, null, ""],
    } as unknown as ReturnType<typeof spawnSync>);
    vi.resetModules();

    const { resolveSubprocessEnv } = await import("./subprocess-env");
    const result = resolveSubprocessEnv({ cwd: "/tmp" });

    expect(result.env.PATH).toBe("/usr/bin:/bin");
  });
});

describe("full shell-env cache (setFullShellEnv / getFullShellEnv)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/bin",
    };
    mockedSpawnSync.mockReset();
    mockSpawnOk("/opt/homebrew/bin:/usr/bin:/bin\n");
    mockedGetInjectedSubprocessEnv.mockReset();
    mockedGetInjectedSubprocessEnv.mockReturnValue({});
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("is empty until a sync populates it", async () => {
    const { resolveSubprocessEnv, getFullShellEnv } = await import("./subprocess-env");
    expect(getFullShellEnv()).toEqual({});
    expect(resolveSubprocessEnv({ cwd: "/tmp" }).env.RC_ONLY_VAR).toBeUndefined();
  });

  it("merges cached full shell env into every subprocess env", async () => {
    const { resolveSubprocessEnv, setFullShellEnv, getFullShellEnv } = await import("./subprocess-env");
    setFullShellEnv({ RC_ONLY_VAR: "from-rc" });

    expect(getFullShellEnv()).toEqual({ RC_ONLY_VAR: "from-rc" });
    const result = resolveSubprocessEnv({ cwd: "/tmp" });
    expect(result.env.RC_ONLY_VAR).toBe("from-rc");
  });

  it("lets getInjectedSubprocessEnv() (credential store) win over the full shell env cache", async () => {
    mockedGetInjectedSubprocessEnv.mockReturnValue({ SHARED: "from-store" });
    const { resolveSubprocessEnv, setFullShellEnv } = await import("./subprocess-env");
    setFullShellEnv({ SHARED: "from-rc" });

    const result = resolveSubprocessEnv({ cwd: "/tmp" });
    expect(result.env.SHARED).toBe("from-store");
  });

  it("lets caller-supplied options.env win over the full shell env cache", async () => {
    const { resolveSubprocessEnv, setFullShellEnv } = await import("./subprocess-env");
    setFullShellEnv({ SHARED: "from-rc" });

    const result = resolveSubprocessEnv({ cwd: "/tmp", env: { SHARED: "from-caller" } });
    expect(result.env.SHARED).toBe("from-caller");
  });

  it("does not let the full shell env cache override the resolved shell PATH merge", async () => {
    const { resolveSubprocessEnv, setFullShellEnv } = await import("./subprocess-env");
    setFullShellEnv({ PATH: "/some/stale/rc/path" });

    const result = resolveSubprocessEnv({ cwd: "/tmp" });
    expect(result.env.PATH).toBe(process.platform === "win32" ? "/usr/bin:/bin" : "/opt/homebrew/bin:/usr/bin:/bin");
  });
});
