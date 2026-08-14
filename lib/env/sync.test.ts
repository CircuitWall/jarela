import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./allowlist", () => ({
  getEffectiveAllowlist: vi.fn(() => []),
  getAllEnvVarNames: vi.fn(() => []),
}));

vi.mock("./discover", () => ({
  discoverAllShellEnv: vi.fn(async () => ({
    values: { FOO: "bar" },
    source: "shell-rc",
    shell: "/bin/zsh",
    warnings: [],
    elapsed_ms: 1,
  })),
}));

vi.mock("@/lib/stores/integrations", () => ({
  INTEGRATIONS: {},
  getIntegrationRaw: vi.fn(() => undefined),
  isKnownIntegration: vi.fn(() => false),
}));

vi.mock("@/lib/stores/integration_meta", () => ({
  getIntegrationMeta: vi.fn(() => ({ source: {} })),
  setFieldSources: vi.fn(),
}));

vi.mock("@/lib/stores/memory", () => ({
  putMemory: vi.fn(),
}));

vi.mock("@/lib/tools/subprocess-env", () => ({
  setFullShellEnv: vi.fn(),
}));

import { discoverAllShellEnv } from "./discover";
import { setFullShellEnv } from "@/lib/tools/subprocess-env";

const mockedDiscoverAllShellEnv = vi.mocked(discoverAllShellEnv);
const mockedSetFullShellEnv = vi.mocked(setFullShellEnv);

describe("env sync / full shell-env cache refresh", () => {
  beforeEach(() => {
    mockedDiscoverAllShellEnv.mockClear();
    mockedSetFullShellEnv.mockClear();
  });

  it("applyEnvSync() probes the full shell env and refreshes the subprocess-env cache", async () => {
    const { applyEnvSync } = await import("./sync");
    await applyEnvSync();

    expect(mockedDiscoverAllShellEnv).toHaveBeenCalledTimes(1);
    expect(mockedSetFullShellEnv).toHaveBeenCalledWith({ FOO: "bar" });
  });

  it("previewEnvSync() does not mutate the subprocess-env cache", async () => {
    const { previewEnvSync } = await import("./sync");
    await previewEnvSync();

    expect(mockedSetFullShellEnv).not.toHaveBeenCalled();
  });
});
