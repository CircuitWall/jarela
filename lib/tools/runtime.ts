import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { RunnableConfig } from "@langchain/core/runnables";

import "./builtins";

import {
  registeredCategory,
  registeredCapability,
  registeredGroup,
  registeredIntegration,
  groupForCategory,
  type Capability,
  type ToolCategory,
  type ToolGroup,
} from "./registry";
import { getMcpTools, getMcpToolMeta } from "@/lib/mcp/client";
import { getToolsDir, loadExternalTools, type ExtensionLoadError } from "./external";
import { loadLangChainPackages } from "./packages/langchain-packages";
import { wrapWithWallclock } from "./wallclock";
import { wrapToolForCredentialRouting } from "./wrap-credentials";
import type { OpenAITool, ToolContext, ToolParamSchema } from "./types";
import type { ToolPolicy } from "@/lib/agents/base";
import { disabledCategories } from "@/lib/stores/builtin-tools";
import { isDropinDisabled } from "@/lib/stores/disabled-dropin-tools";
import { getAgentTools, type AgentConfigRow } from "@/lib/stores/agent-configs";
import { isBasicToolCategory, normalizeToolCategory } from "./categories";
import { isAlwaysOnTool } from "./always-on";
import { getIntegrationReadiness } from "@/lib/health/probe-cache";
import { getInjectedSubprocessEnv } from "@/lib/env/allowlist";
import {
  allBuiltins,
  builtinNames,
  loadExternal,
  getToolCategory,
  getToolCredentialsRequired,
  getToolIntegration,
  getToolSource,
  toCatalogEntry,
  type ToolCatalogEntry,
  type ToolStatus,
  type ToolSource,
  applyAgentPermissionsToCatalog,
  allowedToolNamesFromPermissionMap,
  applyProviderToolLimitToCatalog,
} from "./catalog";

export * from "./catalog";

function applyPolicy(
  tools: StructuredToolInterface[],
  policy?: ToolPolicy,
): StructuredToolInterface[] {
  const allowSet = policy?.allow?.length ? new Set(policy.allow) : null;
  const denySet = policy?.deny?.length ? new Set(policy.deny) : null;
  return tools.filter((t) => {
    if (allowSet && !allowSet.has(t.name)) return false;
    if (denySet && denySet.has(t.name)) return false;
    return true;
  });
}

function applyCategoryToggles(tools: StructuredToolInterface[]): StructuredToolInterface[] {
  const disabled = disabledCategories();
  if (disabled.size === 0) return tools;
  return tools.filter((t) => {
    if (isAlwaysOnTool(t.name)) return true;
    const cat = registeredCategory(t.name);
    if (!cat) return true;
    return !disabled.has(cat);
  });
}

export async function getAllToolCatalogAsync(): Promise<ToolCatalogEntry[]> {
  try {
    await loadLangChainPackages();
  } catch (err) {
    console.error("[tools] LangChain package load failed while building catalog:", err);
  }

  const disabledBuiltinCategories = disabledCategories();
  const external = loadExternal();
  let mcpTools: StructuredToolInterface[] = [];
  try {
    mcpTools = await getMcpTools();
  } catch (err) {
    console.error("[tools] MCP load failed while building catalog:", err);
  }

  const entries = new Map<string, ToolCatalogEntry>();
  for (const tool of allBuiltins()) {
    const category = registeredCategory(tool.name);
    if (!category) continue;
    const disabled = disabledBuiltinCategories.has(category) && !isAlwaysOnTool(tool.name);
    entries.set(tool.name, toCatalogEntry(tool, {
      source: "builtin",
      category,
      capability: registeredCapability(tool.name) ?? "execute",
      group: registeredGroup(tool.name) ?? groupForCategory(category),
      integration: registeredIntegration(tool.name) ?? null,
      status: disabled ? "disabled" : "enabled",
      status_reason: disabled ? "category_disabled" : null,
    }));
  }
  for (const tool of external.tools) {
    const category = normalizeToolCategory(external.categories.get(tool.name)) as ToolCategory;
    const disabled = isDropinDisabled(tool.name);
    entries.set(tool.name, toCatalogEntry(tool, {
      source: "external",
      category,
      capability: "execute",
      group: groupForCategory(category),
      integration: external.integrations.get(tool.name) ?? null,
      credentials_required: external.credentialsRequired.get(tool.name) ?? [],
      status: disabled ? "disabled" : "enabled",
      status_reason: disabled ? "dropin_tool_disabled" : null,
    }));
  }
  for (const tool of mcpTools) {
    const meta = getMcpToolMeta(tool.name);
    const category = normalizeToolCategory(meta?.category) as ToolCategory;
    entries.set(tool.name, toCatalogEntry(tool, {
      source: "mcp",
      category,
      capability: "execute",
      group: "MCP",
      mcp_server: meta?.server_name ?? null,
      integration: meta?.integration ?? null,
      credentials_required: meta?.credentials_required ?? [],
      status: "enabled",
      status_reason: null,
    }));
  }

  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getAllTools(policy?: ToolPolicy): StructuredToolInterface[] {
  const ext = loadExternal();
  return applyPolicy(
    [
      ...applyCategoryToggles(allBuiltins()),
      ...ext.tools.filter((t) => !isDropinDisabled(t.name)).map(wrapWithWallclock),
    ],
    policy,
  );
}

export async function getAllToolsAsync(policy?: ToolPolicy): Promise<StructuredToolInterface[]> {
  try {
    await loadLangChainPackages();
  } catch (err) {
    console.error("[tools] LangChain package load failed, continuing without them:", err);
  }
  let mcpTools: StructuredToolInterface[] = [];
  try {
    mcpTools = await getMcpTools();
  } catch (err) {
    console.error("[tools] MCP load failed, continuing with built-ins only:", err);
  }
  return applyPolicy(
    [
      ...applyCategoryToggles(allBuiltins()),
      ...loadExternal().tools.filter((t) => !isDropinDisabled(t.name)).map(wrapWithWallclock),
      ...mcpTools.map(wrapWithWallclock),
    ],
    policy,
  );
}

export function toOpenAITools(tools: StructuredToolInterface[]): OpenAITool[] {
  return tools.map((t) => {
    const oai = convertToOpenAITool(t);
    return {
      type: "function",
      function: {
        name: oai.function.name,
        description: oai.function.description ?? "",
        parameters: oai.function.parameters as ToolParamSchema,
      },
    };
  });
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext = {},
): Promise<unknown> {
  let t = allBuiltins().find((x) => x.name === name);
  if (t) {
    const cat = registeredCategory(name);
    if (cat && disabledCategories().has(cat) && !isAlwaysOnTool(name)) {
      throw new Error(`Tool "${name}" is disabled (category ${cat} is turned off)`);
    }
  }
  if (!t) {
    const extTool = loadExternal().tools.find((x) => x.name === name);
    if (extTool) {
      if (isDropinDisabled(name)) {
        throw new Error(`Tool "${name}" is disabled`);
      }
      t = extTool;
    }
  }
  if (!t) {
    let mcpTools: StructuredToolInterface[] = [];
    try {
      mcpTools = await getMcpTools();
    } catch (err) {
      throw new Error(`MCP tools are unavailable while resolving "${name}": ${err instanceof Error ? err.message : String(err)}`);
    }
    const mcpTool = mcpTools.find((x) => x.name === name);
    if (mcpTool) t = mcpTool;
  }
  if (!t) throw new Error(`Unknown tool: ${name}`);
  if (!registeredCategory(name)) {
    t = wrapWithWallclock(t);
  }
  if (context.tool_credentials && Object.keys(context.tool_credentials).length > 0) {
    t = wrapToolForCredentialRouting(t, context.tool_credentials);
  }

  const config: RunnableConfig = context.thread_id
    ? { configurable: { thread_id: context.thread_id } }
    : {};

  const result = await t.invoke(args, config);

  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }
  return result;
}

let initialized = false;

export interface InitToolsSummary {
  builtinCount: number;
  externalCount: number;
  errors: ExtensionLoadError[];
  toolsDir: string;
}

export function initTools(): InitToolsSummary {
  const toolsDir = getToolsDir();
  const result = loadExternal();
  const summary: InitToolsSummary = {
    builtinCount: allBuiltins().length,
    externalCount: result.tools.length,
    errors: result.errors,
    toolsDir,
  };

  if (!initialized) {
    console.info(
      `[tools] ${summary.builtinCount} built-in tool(s) registered; ` +
      `${summary.externalCount} external tool(s) loaded from ${toolsDir}`,
    );
    for (const err of summary.errors) {
      console.error(`[tools] external ${err.file}: ${err.error}`);
    }
    initialized = true;
  }
  return summary;
}
