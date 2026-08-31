// Read-only introspection of configured MCP servers — names, transports,
// enabled/disabled state, last connection error, and the count of tools each
// server contributes to the live tool pool. Lets the agent answer "why is
// my Jira tool unavailable?" without bouncing the user through the UI.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { listMcpServers } from "@/lib/stores/mcp-servers";
import { getAllToolCatalogAsync } from "./index";
import { registerLangChainPackage } from "./langchain-package";

interface McpServerSummary {
  name: string;
  transport: "stdio" | "http";
  enabled: boolean;
  last_error: string | null;
  tool_count: number;
  created_at: string;
  updated_at: string;
}

export const listMcpServersTool = tool(
  async () => {
    const rows = listMcpServers();
    const catalog = await getAllToolCatalogAsync();
    const mcpTools = catalog.filter((t) => t.source === "mcp");
    const toolCountsByServer = new Map<string, number>();
    for (const tool of mcpTools) {
      if (!tool.mcp_server) continue;
      toolCountsByServer.set(tool.mcp_server, (toolCountsByServer.get(tool.mcp_server) ?? 0) + 1);
    }

    const servers: McpServerSummary[] = rows.map((r) => ({
      name: r.name,
      transport: r.transport,
      enabled: r.enabled === 1,
      last_error: r.last_error,
      tool_count: r.enabled === 1 ? toolCountsByServer.get(r.name) ?? 0 : 0,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));

    return JSON.stringify({
      servers,
      count: servers.length,
      enabled_count: servers.filter((s) => s.enabled).length,
      total_mcp_tool_count: mcpTools.length,
      notes: [
        "tool_count is attributed per enabled MCP server when the server connection reports tools successfully.",
        "last_error shows the most recent connection error if any; null means " +
          "the server has never failed since last config change.",
      ],
    });
  },
  {
    name: "list_mcp_servers",
    description:
      "List every configured MCP server (stdio or http transport) with its " +
      "enabled state, last connection error, and per-server count of MCP " +
      "tools currently in the agent's pool. Read-only. Use this when " +
      "diagnosing 'my <X> tool isn't working' — check enabled and last_error " +
      "before assuming the tool itself is broken.",
    schema: z.object({}),
  },
);

registerLangChainPackage({
  category: "Config",
  tools: { read: [listMcpServersTool] },
});
