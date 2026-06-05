// Read-only introspection tool — lets the agent enumerate every tool it has
// access to right now (built-in + external + MCP), so it can answer
// "what's in my toolbox / is X available" without the user having to
// describe the project's tool surface in the prompt.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  getAllToolsAsync,
  getToolCategory,
  getToolCapability,
  getToolGroup,
  getToolSource,
  type ToolSource,
} from "./index";
import type { Capability, ToolCategory } from "./registry";
import { registerTools } from "./registry";

interface ToolSummary {
  name: string;
  description: string;
  category: ToolCategory;
  capability: Capability;
  source: ToolSource;
  group: string | null;
}

export const listToolsTool = tool(
  async ({ category, capability, source }) => {
    const all = await getAllToolsAsync();
    const summaries: ToolSummary[] = all.map((t) => ({
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
      category: getToolCategory(t.name),
      capability: getToolCapability(t.name),
      source: getToolSource(t.name),
      group: getToolGroup(t.name),
    }));

    const filtered = summaries.filter((s) =>
      (!category || s.category === category) &&
      (!capability || s.capability === capability) &&
      (!source || s.source === source),
    );

    const counts = {
      total: filtered.length,
      by_source: { builtin: 0, external: 0, mcp: 0 } as Record<ToolSource, number>,
      by_capability: { read: 0, write: 0, execute: 0 } as Record<Capability, number>,
    };
    for (const s of filtered) {
      counts.by_source[s.source]++;
      counts.by_capability[s.capability]++;
    }

    return JSON.stringify({ tools: filtered, counts });
  },
  {
    name: "list_tools",
    description:
      "List every tool currently available to this agent — built-in tools, " +
      "external (~/.jarela/providers JS plugins), and MCP server tools — with " +
      "category, capability (read/write/execute), and source. Read-only. " +
      "Use this when the user asks 'what can you do?', when picking between " +
      "tools for a task, or when troubleshooting whether a specific tool is " +
      "registered. Optional filters narrow by category, capability, or source.",
    schema: z.object({
      category: z
        .string()
        .optional()
        .describe("Optional category filter (e.g. 'Files', 'Mail', 'GitHub', 'MCP')"),
      capability: z
        .enum(["read", "write", "execute"])
        .optional()
        .describe("Optional capability filter — the safety class of the tool"),
      source: z
        .enum(["builtin", "external", "mcp"])
        .optional()
        .describe("Optional source filter — where the tool came from"),
    }),
  },
);

registerTools("Config", "read", [listToolsTool]);
