import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-mcp-servers-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { getDb } = await import("@/lib/db");
const { deleteMcpServer, getMcpServer, listMcpServers, upsertMcpServer } = await import("./mcp-servers");

afterEach(() => {
  for (const row of listMcpServers()) deleteMcpServer(row.name);
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe("MCP server secret storage", () => {
  it("encrypts stdio env and HTTP headers at rest while returning them to the operator UI", () => {
    upsertMcpServer({
      name: "synthetic-stdio",
      transport: "stdio",
      spec: { command: "node", args: [], env: { GITHUB_TOKEN: "synthetic-secret" } },
    });
    upsertMcpServer({
      name: "synthetic-http",
      transport: "http",
      spec: { url: "https://example.test/mcp", headers: { Authorization: "Bearer synthetic-secret" } },
    });

    const rows = getDb()
      .prepare("SELECT name, spec FROM mcp_servers WHERE name LIKE 'synthetic-%'")
      .all() as Array<{ name: string; spec: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.spec).not.toContain("synthetic-secret");
    }

    // The editor needs the values to render and round-trip the environment.
    expect(getMcpServer("synthetic-stdio")?.spec).toContain("synthetic-secret");
    expect(getMcpServer("synthetic-http")?.spec).toContain("synthetic-secret");
  });
});
