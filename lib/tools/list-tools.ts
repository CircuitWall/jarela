// Read-only introspection tool — lets the agent enumerate every tool it has
// access to right now (built-in + external + MCP), so it can answer
// "what's in my toolbox / is X available" without the user having to
// describe the project's tool surface in the prompt.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  applyAgentPermissionsToCatalog,
  applyProviderToolLimitToCatalog,
  getAllToolsAsync,
  getAllToolCatalogAsync,
  toOpenAITools,
  type ToolSource,
} from "./index";
import type { ToolParamSchema } from "./types";
import type { Capability, ToolCategory } from "./registry";
import { registerLangChainPackage } from "./langchain-package";
import { getConfig } from "@/lib/env/config";
import { getAgentConfig, getAgentTools } from "@/lib/stores/agent-configs";
import { getThread } from "@/lib/stores/threads";

interface ToolSummary {
  name: string;
  description: string;
  category: ToolCategory;
  capability: Capability;
  source: ToolSource;
  group: string | null;
  mcp_server: string | null;
  status: "enabled" | "disabled" | "unavailable";
  status_reason: string | null;
  permission: "enabled" | "disabled" | "unavailable";
  permission_reason: string | null;
  input_schema?: ToolParamSchema | null;
}

export const listToolsTool = tool(
  async ({ query, category, capability, source, permission, scope, include_disabled, include_schema }, config?: RunnableConfig) => {
    const catalog = await getAllToolCatalogAsync();
    const schemasByName = include_schema ? await loadInputSchemas() : new Map<string, ToolParamSchema>();
    const agentCfg = agentFromConfig(config);
    const permissionMap = applyAgentPermissionsToCatalog(catalog, agentCfg);
    const allowedNames = permissionMap
      .filter((entry) => entry.permission === "enabled")
      .map((entry) => entry.name);
    const capped = applyProviderToolLimitToCatalog(
      permissionMap,
      allowedNames,
      getConfig().providerToolLimit,
      getAgentTools(agentCfg),
    );
    const summaries: ToolSummary[] = applyRunPermissionOverlay(capped.toolPermissionMap, config).map((t) => ({
      name: t.name,
      description: t.description,
      category: t.category,
      capability: t.capability,
      source: t.source,
      group: t.group,
      mcp_server: t.mcp_server ?? null,
      status: t.status,
      status_reason: t.status_reason,
      permission: t.permission ?? "disabled",
      permission_reason: t.permission_reason ?? null,
      ...(include_schema ? { input_schema: schemasByName.get(t.name) ?? null } : {}),
    }));

    const q = typeof query === "string" ? query.trim().toLowerCase() : "";
    const resolvedScope = scope ?? (include_disabled === false ? "enabled" : "all");
    const filtered = summaries.filter((s) =>
      (!q || toolSearchText(s).includes(q)) &&
      (!category || s.category === category) &&
      (!capability || s.capability === capability) &&
      (!source || s.source === source) &&
      (!permission || s.permission === permission) &&
      (resolvedScope !== "enabled" || s.permission === "enabled"),
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
      "Use scope='enabled' to list/search only executable tools, or scope='all' to include disabled/unavailable tools with flags. " +
      "Set include_schema=true before calling invoke_tool so you can pass arguments matching the target tool schema.",
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
      scope: z
        .enum(["enabled", "all"])
        .optional()
        .describe("Whether to list/search only enabled executable tools or all known tools with permission flags. Defaults to 'all'."),
      permission: z
        .enum(["enabled", "disabled", "unavailable"])
        .optional()
        .describe("Optional per-agent permission filter"),
      include_disabled: z
        .boolean()
        .optional()
        .describe("Deprecated compatibility flag. list_tools now always includes known tools with their permission status."),
      include_schema: z
        .boolean()
        .optional()
        .describe("When true, include each matched tool's JSON input schema when available. Use for preparing invoke_tool args."),
    }),
  },
);

async function loadInputSchemas(): Promise<Map<string, ToolParamSchema>> {
  const tools = await getAllToolsAsync();
  return new Map(toOpenAITools(tools).map((toolDef) => [
    toolDef.function.name,
    toolDef.function.parameters,
  ]));
}

function toolSearchText(tool: ToolSummary): string {
  return [
    tool.name,
    tool.description,
    tool.category,
    tool.capability,
    tool.source,
    tool.group ?? "",
    tool.mcp_server ?? "",
    tool.status,
    tool.status_reason ?? "",
    tool.permission,
    tool.permission_reason ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

function applyRunPermissionOverlay<T extends {
  name: string;
  permission?: ToolSummary["permission"];
  permission_reason?: string | null;
}>(
  catalog: ReadonlyArray<T>,
  config?: RunnableConfig,
): ReadonlyArray<T> {
  type PermissionOverlay = Array<{
    name?: unknown;
    permission?: unknown;
    permission_reason?: unknown;
  }>;
  const runConfig = config?.configurable?.agent_run_config as { tool_permission_map?: PermissionOverlay } | undefined;
  const runPermissionMap = (
    config?.configurable?.tool_permission_map
    ?? runConfig?.tool_permission_map
  ) as PermissionOverlay | undefined;
  if (!Array.isArray(runPermissionMap)) return catalog;
  const byName = new Map<string, { permission: ToolSummary["permission"]; permission_reason: string | null }>();
  for (const entry of runPermissionMap) {
    if (
      typeof entry.name === "string"
      && (entry.permission === "enabled" || entry.permission === "disabled" || entry.permission === "unavailable")
    ) {
      byName.set(entry.name, {
        permission: entry.permission,
        permission_reason: typeof entry.permission_reason === "string" ? entry.permission_reason : null,
      });
    }
  }
  return catalog.map((entry) => {
    const overlay = byName.get(entry.name);
    return overlay ? { ...entry, ...overlay } : entry;
  });
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
