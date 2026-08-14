import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/env/allowlist", () => ({
  getInjectedSubprocessEnv: vi.fn(() => ({})),
}));

vi.mock("@/lib/tools/subprocess-env", () => ({
  getFullShellEnv: vi.fn(() => ({})),
}));

vi.mock("@/lib/stores/mcp-servers", () => ({
  listMcpServers: vi.fn(() => []),
  setMcpServerError: vi.fn(),
}));

import { getInjectedSubprocessEnv } from "@/lib/env/allowlist";
import { getFullShellEnv } from "@/lib/tools/subprocess-env";

const mockedGetInjected = vi.mocked(getInjectedSubprocessEnv);
const mockedGetFullShellEnv = vi.mocked(getFullShellEnv);

describe("buildSubprocessEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, PATH: "/usr/bin:/bin" };
    mockedGetInjected.mockReset();
    mockedGetInjected.mockReturnValue({});
    mockedGetFullShellEnv.mockReset();
    mockedGetFullShellEnv.mockReturnValue({});
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("merges the full-shell-env cache in, below the injected credential store", async () => {
    mockedGetFullShellEnv.mockReturnValue({ RC_ONLY_VAR: "from-rc" });
    const { buildSubprocessEnv } = await import("./client");

    const env = buildSubprocessEnv({});
    expect(env.RC_ONLY_VAR).toBe("from-rc");
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("lets getInjectedSubprocessEnv() win over the full-shell-env cache for the same var", async () => {
    mockedGetFullShellEnv.mockReturnValue({ SHARED: "from-rc" });
    mockedGetInjected.mockReturnValue({ SHARED: "from-store" });
    const { buildSubprocessEnv } = await import("./client");

    const env = buildSubprocessEnv({});
    expect(env.SHARED).toBe("from-store");
  });

  it("lets per-server spec.env win over the full-shell-env cache", async () => {
    mockedGetFullShellEnv.mockReturnValue({ SHARED: "from-rc" });
    const { buildSubprocessEnv } = await import("./client");

    const env = buildSubprocessEnv({ SHARED: "from-spec" });
    expect(env.SHARED).toBe("from-spec");
  });

  it("still scrubs internal vars even when the full-shell-env cache tries to set them", async () => {
    mockedGetFullShellEnv.mockReturnValue({ JARELA_DB_DIR: "/should/not/leak", NPM_TOKEN: "secret" });
    const { buildSubprocessEnv } = await import("./client");

    const env = buildSubprocessEnv({});
    expect(env.JARELA_DB_DIR).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
  });
});
