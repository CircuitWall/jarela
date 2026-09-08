import type { StructuredToolInterface } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";

import {
  registeredTools,
  registeredNames,
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
import {
  loadExternalTools,
  getToolsDir,
  type ExtensionLoadError,
} from "./external";
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
import { getAllTools, getAllToolsAsync } from "./runtime";

export type ToolSource = "builtin" | "external" | "mcp";
export type ToolStatus = "enabled" | "disabled" | "unavailable";
export type ToolPermissionState = "enabled" | "disabled" | "unavailable";

export interface ToolCatalogEntry {
  name: string;
  description: string;
  source: ToolSource;
  category: ToolCategory;
  capability: Capability;
  group: ToolGroup;
  mcp_server?: string | null;
  integration?: string | null;
  credentials_required: string[];
  status: ToolStatus;
  status_reason: string | null;
  permission?: ToolPermissionState;
  permission_reason?: string | null;
}

export interface ProviderToolLimitResult {
  toolPermissionMap: ToolCatalogEntry[];
  allowedToolNames: string[];
  omittedToolNames: string[];
}

export interface ProviderToolLimitOptions {
  candidateQuery?: string;
  preferredToolNames?: readonly string[];
}

export function allBuiltins(): StructuredToolInterface[] {
  return registeredTools();
}

export function builtinNames(): ReadonlySet<string> {
  return registeredNames();
}

export function loadExternal() {
  return loadExternalTools(builtinNames());
}

const DEFAULT_EXCLUDED_BASIC_TOOLS = new Set([
  "terminal_open",
  "terminal_exec",
  "terminal_send",
  "terminal_read",
  "terminal_close",
  "terminal_list",
]);

export function getBuiltinToolNames(): ReadonlySet<string> {
  return builtinNames();
}

export function getToolSource(name: string): ToolSource {
  if (builtinNames().has(name)) return "builtin";
  if (loadExternal().tools.some((t) => t.name === name)) return "external";
  return "mcp";
}

export function getToolCapability(name: string): Capability {
  return registeredCapability(name) ?? "execute";
}

export function getToolCategory(name: string): ToolCategory {
  const builtin = registeredCategory(name);
  if (builtin) return builtin;
  const ext = loadExternal().categories.get(name);
  if (ext) return normalizeToolCategory(ext) as ToolCategory;
  if (getToolSource(name) === "external") return "Other";
  const mcpCat = getMcpToolMeta(name)?.category;
  return normalizeToolCategory(mcpCat) as ToolCategory;
}

export function getToolGroup(name: string): ToolGroup {
  const cat = getToolCategory(name);
  if (cat === "MCP") return null;
  const builtinGroup = registeredGroup(name);
  if (builtinGroup !== undefined) return builtinGroup;
  const mcpGroup = getMcpToolMeta(name)?.group;
  if (mcpGroup !== undefined) return mcpGroup as ToolGroup;
  return groupForCategory(cat);
}

export function getToolCredentialsRequired(name: string): string[] {
  if (registeredCategory(name)) return [];
  const ext = loadExternal().credentialsRequired.get(name);
  if (ext?.length) return ext;
  return getMcpToolMeta(name)?.credentials_required ?? [];
}

export function getToolIntegration(name: string): string | null {
  return registeredIntegration(name)
    ?? loadExternal().integrations.get(name)
    ?? getMcpToolMeta(name)?.integration
    ?? null;
}

function missingCredentialKeys(keys: readonly string[]): string[] {
  if (keys.length === 0) return [];
  let injected: Record<string, string> = {};
  try {
    injected = getInjectedSubprocessEnv();
  } catch {
    // master key locked — fall back to process env only
  }
  return keys.filter((key) => {
    const fromEnv = process.env[key];
    if (fromEnv && fromEnv.trim() !== "") return false;
    const fromStore = injected[key];
    return !fromStore || fromStore.trim() === "";
  });
}

function unconfiguredReason(entry: ToolCatalogEntry): string | null {
  if (missingCredentialKeys(entry.credentials_required).length > 0) return "credentials_missing";
  if (getIntegrationReadiness(entry.integration) === "unconfigured") return "integration_unconfigured";
  return null;
}

export function getDefaultAgentToolNames(): string[] {
  return getAllTools()
    .filter((t) => isDefaultBasicTool(t.name, getToolCategory(t.name)))
    .map((t) => t.name);
}

export async function getDefaultAgentToolNamesAsync(): Promise<string[]> {
  const tools = await getAllToolsAsync();
  return tools
    .filter((t) => isDefaultBasicTool(t.name, getToolCategory(t.name)))
    .map((t) => t.name);
}

function isDefaultBasicTool(name: string, category: string): boolean {
  return isBasicToolCategory(category) && !DEFAULT_EXCLUDED_BASIC_TOOLS.has(name);
}

export function isHotLoadTool(entry: Pick<ToolCatalogEntry, "name" | "category">): boolean {
  return isDefaultBasicTool(entry.name, entry.category);
}

export function markProxyOnlyTools(
  catalog: readonly ToolCatalogEntry[],
  boundToolNames: readonly string[],
  permittedToolNames: readonly string[],
): ToolCatalogEntry[] {
  const bound = new Set(boundToolNames);
  const permitted = new Set(permittedToolNames);
  return catalog.map((entry) => {
    if (entry.permission !== "enabled") return entry;
    if (bound.has(entry.name) || !permitted.has(entry.name)) return entry;
    return { ...entry, permission: "disabled" as const, permission_reason: "proxy_only" };
  });
}

export function applyAgentPermissionsToCatalog(
  catalog: readonly ToolCatalogEntry[],
  cfg: Pick<AgentConfigRow, "tools"> | null | undefined,
): ToolCatalogEntry[] {
  const explicitlyAllowed = new Set(getAgentTools(cfg));
  return catalog.map((entry) => {
    if (entry.status !== "enabled") {
      return {
        ...entry,
        permission: "unavailable" as const,
        permission_reason: entry.status_reason ?? "tool_unavailable",
      };
    }
    const unconfigured = unconfiguredReason(entry);
    if (unconfigured) {
      return {
        ...entry,
        permission: "unavailable" as const,
        permission_reason: unconfigured,
      };
    }
    if (explicitlyAllowed.has(entry.name) || isDefaultBasicTool(entry.name, entry.category)) {
      return {
        ...entry,
        permission: "enabled" as const,
        permission_reason: isDefaultBasicTool(entry.name, entry.category) && !explicitlyAllowed.has(entry.name)
          ? "basic_default"
          : "agent_allowed",
      };
    }
    return {
      ...entry,
      permission: "disabled" as const,
      permission_reason: "agent_not_allowed",
    };
  });
}

export function allowedToolNamesFromPermissionMap(catalog: readonly ToolCatalogEntry[]): string[] {
  return catalog
    .filter((entry) => entry.permission === "enabled")
    .map((entry) => entry.name);
}

export function applyProviderToolLimitToCatalog(
  catalog: readonly ToolCatalogEntry[],
  allowedToolNames: readonly string[],
  limit: number,
  priorityToolNames: readonly string[] = [],
  options: ProviderToolLimitOptions = {},
): ProviderToolLimitResult {
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : allowedToolNames.length;
  const allowedSet = new Set(allowedToolNames);
  const catalogByName = new Map(catalog.map((entry) => [entry.name, entry]));
  const permissionMap = catalog.map((entry) => {
    if (entry.status === "enabled" && allowedSet.has(entry.name) && entry.permission !== "enabled") {
      return {
        ...entry,
        permission: "enabled" as const,
        permission_reason: "runtime_default",
      };
    }
    return entry;
  });

  if (allowedToolNames.length <= normalizedLimit) {
    return {
      toolPermissionMap: permissionMap,
      allowedToolNames: [...allowedToolNames],
      omittedToolNames: [],
    };
  }

  const selected: string[] = [];
  const selectedSet = new Set<string>();
  const add = (name: string) => {
    if (!allowedSet.has(name) || selectedSet.has(name) || selected.length >= normalizedLimit) return;
    selected.push(name);
    selectedSet.add(name);
  };

  for (const name of priorityToolNames) add(name);
  const remaining = allowedToolNames
    .filter((name) => !selectedSet.has(name))
    .map((name, index) => ({ name, index, score: scoreToolCandidate(catalogByName.get(name), options) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  for (const candidate of remaining) add(candidate.name);

  const omittedToolNames = allowedToolNames.filter((name) => !selectedSet.has(name));
  const omittedSet = new Set(omittedToolNames);
  return {
    allowedToolNames: selected,
    omittedToolNames,
    toolPermissionMap: permissionMap.map((entry) => {
      if (entry.permission === "enabled" && omittedSet.has(entry.name)) {
        return {
          ...entry,
          permission: "disabled" as const,
          permission_reason: "provider_tool_limit",
        };
      }
      return entry;
    }),
  };
}

function scoreToolCandidate(
  entry: ToolCatalogEntry | undefined,
  options: ProviderToolLimitOptions,
): number {
  if (!entry) return 0;
  const preferred = new Set(options.preferredToolNames ?? []);
  let score = preferred.has(entry.name) ? 25 : 0;
  const queryTokens = tokenizeForToolSelection(options.candidateQuery ?? "");
  if (queryTokens.length === 0) return score;

  const nameTokens = tokenizeForToolSelection(entry.name);
  const categoryTokens = tokenizeForToolSelection(`${entry.category} ${entry.group ?? ""} ${entry.source}`);
  const descriptionTokens = tokenizeForToolSelection(entry.description);
  const nameTokenSet = new Set(nameTokens);
  const categoryTokenSet = new Set(categoryTokens);
  const descriptionTokenSet = new Set(descriptionTokens);

  for (const token of queryTokens) {
    if (entry.name.toLowerCase().includes(token)) score += 10;
    if (nameTokenSet.has(token)) score += 8;
    if (categoryTokenSet.has(token)) score += 4;
    if (descriptionTokenSet.has(token)) score += 2;
  }

  return score;
}

const TOOL_SELECTION_STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "for", "to", "of", "in", "on", "at",
  "by", "with", "from", "as", "is", "are", "was", "were", "be", "been", "being", "i", "me", "my",
  "you", "your", "we", "our", "it", "its", "this", "that", "these", "those", "can", "could", "would",
  "should", "will", "please", "help", "need", "want", "make", "get", "set", "use", "using",
]);

function tokenizeForToolSelection(text: string): string[] {
  const seen = new Set<string>();
  const tokens = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 2 && !TOOL_SELECTION_STOP_WORDS.has(token));
  for (const token of tokens) seen.add(token);
  return [...seen];
}

export function toCatalogEntry(
  tool: StructuredToolInterface,
  meta: {
    source: ToolSource;
    category: ToolCategory;
    capability: Capability;
    group: ToolGroup | undefined;
    mcp_server?: string | null;
    integration?: string | null;
    credentials_required?: string[];
    status: ToolStatus;
    status_reason: string | null;
  },
): ToolCatalogEntry {
  return {
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : "",
    source: meta.source,
    category: meta.category,
    capability: meta.capability,
    group: meta.group ?? null,
    mcp_server: meta.mcp_server ?? null,
    integration: meta.integration ?? null,
    credentials_required: meta.credentials_required ?? [],
    status: meta.status,
    status_reason: meta.status_reason,
  };
}

