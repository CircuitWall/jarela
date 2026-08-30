// Read-only introspection tool — lets the agent enumerate every tool it has
// access to right now (built-in + external + MCP), so it can answer
// "what's in my toolbox / is X available" without the user having to
// describe the project's tool surface in the prompt.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  applyAgentPermissionsToCatalog,
  getAllToolCatalogAsync,
  type ToolSource,
} from "./index";
import type { Capability, ToolCategory } from "./registry";
import { registerLangChainPackage } from "./langchain-package";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { getThread } from "@/lib/stores/threads";

interface ToolSummary {
  name: string;
  description: string;
  category: ToolCategory;
  capability: Capability;
  source: ToolSource;
  group: string | null;
  status: "enabled" | "disabled" | "unavailable";
  status_reason: string | null;
  permission: "enabled" | "disabled" | "unavailable";
  permission_reason: string | null;
}

export const listToolsTool = tool(
  async ({ query, category, capability, source, include_disabled, permission }, config?: RunnableConfig) => {
    const catalog = await getAllToolCatalogAsync();
    const agentCfg = agentFromConfig(config);
    const summaries: ToolSummary[] = applyAgentPermissionsToCatalog(catalog, agentCfg).map((t) => ({
      name: t.name,
      description: t.description,
      category: t.category,
      capability: t.capability,
      source: t.source,
      group: t.group,
      status: t.status,
      status_reason: t.status_reason,
      permission: t.permission ?? "disabled",
      permission_reason: t.permission_reason ?? null,
    }));

    const q = typeof query === "string" ? query.trim().toLowerCase() : "";
    const filtered = summaries.filter((s) =>
      (!q || toolSearchText(s).includes(q)) &&
      (!category || s.category === category) &&
      (!capability || s.capability === capability) &&
      (!source || s.source === source) &&
      (!permission || s.permission === permission) &&
      (include_disabled === true || s.permission === "enabled"),
    );

    const counts = {
      total: filtered.length,
      by_source: { builtin: 0, external: 0, mcp: 0 } as Record<ToolSource, number>,
      by_capability: { read: 0, write: 0, execute: 0 } as Record<Capability, number>,
      by_permission: { enabled: 0, disabled: 0, unavailable: 0 },
    };
    for (const s of filtered) {
      counts.by_source[s.source]++;
      counts.by_capability[s.capability]++;
      counts.by_permission[s.permission]++;
    }

    return JSON.stringify({ tools: filtered, counts });
  },
  {
    name: "list_tools",
    description:
      "List every tool currently available to this agent — built-in tools, " +
      "external (~/.jarela/providers JS plugins), and MCP server tools — with " +
      "category, capability (read/write/execute), source, and permission status. Read-only. " +
      "Use this when the user asks 'what can you do?', when picking between " +
      "tools for a task, or when troubleshooting whether a specific tool is " +
      "registered or disabled. Optional filters narrow by category, capability, source, or permission. " +
      "Set include_disabled=true to see tools that exist but this agent cannot execute; ask the user before proposing permission changes.",
    schema: z.object({
      query: z
        .string()
        .optional()
        .describe("Optional search query matched against name, description, category, capability, source, and group."),
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
      permission: z
        .enum(["enabled", "disabled", "unavailable"])
        .optional()
        .describe("Optional per-agent permission filter"),
      include_disabled: z
        .boolean()
        .optional()
        .describe("When true, include known tools that are disabled for this agent or globally unavailable"),
    }),
  },
);

function toolSearchText(tool: ToolSummary): string {
  return [
    tool.name,
    tool.description,
    tool.category,
    tool.capability,
    tool.source,
    tool.group ?? "",
    tool.status,
    tool.status_reason ?? "",
    tool.permission,
    tool.permission_reason ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

function agentFromConfig(config?: RunnableConfig) {
  const threadId = config?.configurable?.thread_id as string | undefined;
  if (!threadId) return null;
  const thread = getThread(threadId);
  if (!thread?.agent_id) return null;
  return getAgentConfig(thread.agent_id);
}

registerLangChainPackage({
  category: "Config",
  tools: { read: [listToolsTool] },
});
