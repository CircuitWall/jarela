import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mcpToolsByServer = vi.hoisted(() => new Map<string, unknown[]>());

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

vi.mock("@langchain/mcp-adapters", () => ({
  MultiServerMCPClient: class {
    private opts: { mcpServers: Record<string, unknown> };

    constructor(opts: { mcpServers: Record<string, unknown> }) {
      this.opts = opts;
    }

    async getTools() {
      const serverName = Object.keys(this.opts.mcpServers)[0];
      return mcpToolsByServer.get(serverName) ?? [];
    }

    async close() {}
  },
}));

import { getInjectedSubprocessEnv } from "@/lib/env/allowlist";
import { listMcpServers } from "@/lib/stores/mcp-servers";
import { getFullShellEnv } from "@/lib/tools/subprocess-env";

const mockedGetInjected = vi.mocked(getInjectedSubprocessEnv);
const mockedGetFullShellEnv = vi.mocked(getFullShellEnv);
const mockedListMcpServers = vi.mocked(listMcpServers);

describe("buildSubprocessEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, PATH: "/usr/bin:/bin" };
    mockedGetInjected.mockReset();
    mockedGetInjected.mockReturnValue({});
    mockedGetFullShellEnv.mockReset();
    mockedGetFullShellEnv.mockReturnValue({});
    mockedListMcpServers.mockReset();
    mockedListMcpServers.mockReturnValue([]);
    mcpToolsByServer.clear();
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("getMcpTools", () => {
    it("records the source MCP server for each loaded tool", async () => {
      mockedListMcpServers.mockReturnValue([
        {
          name: "filesystem",
          transport: "stdio",
          spec: JSON.stringify({ command: "node" }),
          enabled: 1,
          last_error: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ]);
      mcpToolsByServer.set("filesystem", [
        {
          name: "read_file",
          description: "Read a file",
          metadata: { annotations: { category: "Files", credentials_required: ["fs_token"] } },
        },
      ]);

      const { getMcpTools, getMcpToolMeta } = await import("./client");
      await getMcpTools();

      expect(getMcpToolMeta("read_file")).toMatchObject({
        category: "Files",
        credentials_required: ["fs_token"],
        server_name: "filesystem",
      });
    });
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
