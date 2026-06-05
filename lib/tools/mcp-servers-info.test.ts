import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-mcp-info-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { listMcpServersTool } = await import("./mcp-servers-info");
const { upsertMcpServer } = await import("@/lib/stores/mcp-servers");

interface Result {
  servers: Array<{
    name: string;
    transport: string;
    enabled: boolean;
    last_error: string | null;
    tool_count: number;
  }>;
  count: number;
  enabled_count: number;
  total_mcp_tool_count: number;
  notes: string[];
}

function parse(s: string): Result {
  return JSON.parse(s) as Result;
}

describe("list_mcp_servers", () => {
  it("returns empty list with zero counts when no servers are configured", async () => {
    const out = parse(await listMcpServersTool.invoke({}));
    expect(out.servers).toEqual([]);
    expect(out.count).toBe(0);
    expect(out.enabled_count).toBe(0);
    expect(out.notes.length).toBeGreaterThan(0);
  });

  it("surfaces configured servers with enabled state and transport", async () => {
    upsertMcpServer({
      name: "fake-stdio-server",
      transport: "stdio",
      spec: { command: "echo", args: ["hello"] },
      enabled: false,
    });
    upsertMcpServer({
      name: "fake-http-server",
      transport: "http",
      spec: { url: "http://localhost:9999" },
      enabled: true,
    });

    const out = parse(await listMcpServersTool.invoke({}));
    const names = out.servers.map((s) => s.name).sort();
    expect(names).toEqual(["fake-http-server", "fake-stdio-server"]);

    const stdioRow = out.servers.find((s) => s.name === "fake-stdio-server");
    expect(stdioRow?.transport).toBe("stdio");
    expect(stdioRow?.enabled).toBe(false);

    const httpRow = out.servers.find((s) => s.name === "fake-http-server");
    expect(httpRow?.transport).toBe("http");
    expect(httpRow?.enabled).toBe(true);

    expect(out.enabled_count).toBe(1);
    expect(out.count).toBe(2);
  });
});
