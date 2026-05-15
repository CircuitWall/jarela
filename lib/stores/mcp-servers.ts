import { getDb } from "@/lib/db";

const now = () => new Date().toISOString();

export type McpTransport = "stdio" | "http";

export interface McpStdioSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpSpec {
  url: string;
  headers?: Record<string, string>;
}

export interface McpServerRow {
  name: string;
  transport: McpTransport;
  spec: string;            // JSON-encoded McpStdioSpec | McpHttpSpec
  enabled: number;         // 0 | 1
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface McpServerInput {
  name: string;
  transport: McpTransport;
  spec: McpStdioSpec | McpHttpSpec;
  enabled?: boolean;
}

export function listMcpServers(): McpServerRow[] {
  return getDb()
    .prepare("SELECT * FROM mcp_servers ORDER BY name ASC")
    .all() as unknown as McpServerRow[];
}

export function getMcpServer(name: string): McpServerRow | null {
  return (getDb()
    .prepare("SELECT * FROM mcp_servers WHERE name=?")
    .get(name) as unknown as McpServerRow) ?? null;
}

export function upsertMcpServer(input: McpServerInput): McpServerRow {
  const t = now();
  const existing = getMcpServer(input.name);
  const created_at = existing?.created_at ?? t;
  const enabled = input.enabled === false ? 0 : 1;
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO mcp_servers (name, transport, spec, enabled, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(input.name, input.transport, JSON.stringify(input.spec), enabled, created_at, t);
  return getMcpServer(input.name)!;
}

export function deleteMcpServer(name: string): boolean {
  return (getDb()
    .prepare("DELETE FROM mcp_servers WHERE name=?")
    .run(name) as { changes: number }).changes > 0;
}

export function setMcpServerError(name: string, error: string | null): void {
  getDb()
    .prepare("UPDATE mcp_servers SET last_error=?, updated_at=? WHERE name=?")
    .run(error, now(), name);
}
