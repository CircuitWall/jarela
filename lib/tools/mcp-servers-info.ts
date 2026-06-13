// Read-only introspection of configured MCP servers — names, transports,
// enabled/disabled state, last connection error, and the count of tools each
// server contributes to the live tool pool. Lets the agent answer "why is
// my Jira tool unavailable?" without bouncing the user through the UI.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { listMcpServers } from "@/lib/stores/mcp-servers";
import { getAllToolsAsync } from "./index";
import { getToolSource } from "./index";
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
    const allTools = await getAllToolsAsync();
    // MCP tools don't carry their server name as a structured field — for
    // the per-server count we count every tool whose source is "mcp", and
    // we surface the total separately. Per-server attribution would require
    // a deeper hook into MultiServerMCPClient's tool-namespace metadata,
    // which is a bigger change than this introspection step warrants today.
    const totalMcp = allTools.filter((t) => getToolSource(t.name) === "mcp").length;

    const servers: McpServerSummary[] = rows.map((r) => ({
      name: r.name,
      transport: r.transport,
      enabled: r.enabled === 1,
      last_error: r.last_error,
      // Per-server tool count not yet attributable; surface total on every
      // row for now and document the limitation in `notes` below.
      tool_count: r.enabled === 1 ? totalMcp : 0,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));

    return JSON.stringify({
      servers,
      count: servers.length,
      enabled_count: servers.filter((s) => s.enabled).length,
      total_mcp_tool_count: totalMcp,
      notes: [
        "tool_count is an aggregate across all enabled MCP servers — per-server " +
          "attribution requires deeper namespace tracking that's not implemented yet.",
        "last_error shows the most recent connection error if any; null means " +
          "the server has never failed since last config change.",
      ],
    });
  },
  {
    name: "list_mcp_servers",
    description:
      "List every configured MCP server (stdio or http transport) with its " +
      "enabled state, last connection error, and the aggregate count of MCP " +
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
