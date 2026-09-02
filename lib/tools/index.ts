// Public tool surface for the agent runtime.
//
// Built-in tools register themselves at module load (see ./registry.ts and
// ./builtins.ts). External tools live under JARELA_TOOLS_DIR and are
// loaded per-call (hot-reload). MCP tools come from lib/mcp/client.ts.
//
// To add a new built-in tool:
//   1. Copy lib/tools/template.ts to lib/tools/<name>.ts and implement it.
//   2. Call `registerLangChainPackage({ category, tools: { read|write|execute: [yourTool, ...] } })` at the bottom.
//   3. Add `import "./<name>";` to lib/tools/builtins.ts.
//
// That's it — no central array to update, no parallel category map.

import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { RunnableConfig } from "@langchain/core/runnables";

// Side-effect import: triggers registerLangChainPackage() in every built-in module.
import "./builtins";

import {
  registeredTools,
  registeredNames,
  registeredCategory,
  registeredCapability,
  registeredGroup,
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
import { loadLangChainPackages } from "./langchain-packages";
import { wrapWithWallclock } from "./wallclock";
import { wrapToolForCredentialRouting } from "./wrap-credentials";
import type { OpenAITool, ToolContext, ToolParamSchema } from "./types";
import type { ToolPolicy } from "@/lib/agents/base";
import { disabledCategories } from "@/lib/stores/builtin-tools";
import { isDropinDisabled } from "@/lib/stores/disabled-dropin-tools";
import { getAgentTools, type AgentConfigRow } from "@/lib/stores/agent-configs";
import { isBasicToolCategory, normalizeToolCategory } from "./categories";

export * from "./types";
export { getToolsDir, type ExtensionLoadError } from "./external";
export {
  loadLangChainPackages,
  reloadLangChainPackages,
  getPackagesDir,
  type LangChainPackageManifest,
  type LangChainPackageLoadResult,
  type LangChainPackageLoadError,
} from "./langchain-packages";
export {
  registerTools,
  type Capability,
  type ToolCategory,
  type ToolGroup,
} from "./registry";

// Live accessors — DO NOT snapshot at module-load time. Some tool modules
// import back from this file (for `getAllToolsAsync` etc.) and would create
// a circular import cycle: their `registerLangChainPackage(...)` call runs
// AFTER this module finishes evaluating, so any captured snapshot here would
// miss them and they'd silently disappear from the agent's tool pool. Live
// calls dodge the problem — by the time anyone INVOKES `getAllTools()` /
// etc., every builtin has registered.
function allBuiltins(): StructuredToolInterface[] {
  return registeredTools();
}
function builtinNames(): ReadonlySet<string> {
  return registeredNames();
}

const DEFAULT_EXCLUDED_BASIC_TOOLS = new Set([
  "terminal_open",
  "terminal_exec",
  "terminal_send",
  "terminal_read",
  "terminal_close",
  "terminal_list",
]);

// Backwards-compatible export. Callers that import this Set get its current
// contents at the moment they read it (a fresh Set each access). Internal
// code prefers `builtinNames()` directly; this stays for external consumers
// like the extensions API route.
export function getBuiltinToolNames(): ReadonlySet<string> {
  return builtinNames();
}

// Per-call recompute so files dropped in $JARELA_TOOLS_DIR are picked up
// without restart. loadExternalTools cache-busts require() per file.
function loadExternal() {
  return loadExternalTools(builtinNames());
}

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
  credentials_required: string[];
  status: ToolStatus;
  status_reason: string | null;
  permission?: ToolPermissionState;
  permission_reason?: string | null;
}

// Resolve a tool's origin from its name. Used to label rows in the tools
// API and to route metadata lookups. Returns "mcp" for any name that is
// neither a registered built-in nor an external (JARELA_TOOLS_DIR) tool —
// matches today's behavior where MCP tools are everything else.
export function getToolSource(name: string): ToolSource {
  if (builtinNames().has(name)) return "builtin";
  if (loadExternal().tools.some((t) => t.name === name)) return "external";
  return "mcp";
}

// Look up a tool's safety class. Built-in tools have a declared capability;
// external (JARELA_TOOLS_DIR) and MCP tools default to "execute" — the
// conservative choice until manifest-level overrides land (ADR-0038).
// Source is derived internally so callers can't mis-tag external tools as
// MCP (or vice versa).
export function getToolCapability(name: string): Capability {
  return registeredCapability(name) ?? "execute";
}

export function getToolCategory(name: string): ToolCategory {
  const builtin = registeredCategory(name);
  if (builtin) return builtin;
  const ext = loadExternal().categories.get(name);
  if (ext) return normalizeToolCategory(ext) as ToolCategory;
  if (getToolSource(name) === "external") return "Other";
  // MCP tools can declare a category in their tool annotations; fall back to
  // "Other" only when none is declared so every incoming tool has a category.
  const mcpCat = getMcpToolMeta(name)?.category;
  return normalizeToolCategory(mcpCat) as ToolCategory;
}

export function getToolGroup(name: string): ToolGroup {
  const cat = getToolCategory(name);
  if (cat === "MCP") return null;
  // Built-ins carry their group from the registry.
  const builtinGroup = registeredGroup(name);
  if (builtinGroup !== undefined) return builtinGroup;
  // MCP tools can declare an explicit group; if not, infer from the category
  // (so an MCP tool claiming category "GitHub" inherits the "Work" group).
  const mcpGroup = getMcpToolMeta(name)?.group;
  if (mcpGroup !== undefined) return mcpGroup as ToolGroup;
  return groupForCategory(cat);
}

/**
 * Credential keys this tool requires. Non-empty for external (.cjs) and MCP
 * tools that declare them; always empty for built-ins (they handle their own
 * auth via the Settings → Credentials panel).
 */
export function getToolCredentialsRequired(name: string): string[] {
  if (registeredCategory(name)) return [];
  const ext = loadExternal().credentialsRequired.get(name);
  if (ext?.length) return ext;
  return getMcpToolMeta(name)?.credentials_required ?? [];
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

/**
 * Tools bound directly to the model each turn. Everything else the agent is
 * permitted to run stays reachable through the `invoke_tool` proxy, so the
 * bound set stays small without shrinking what the agent may execute.
 */
export function isHotLoadTool(entry: Pick<ToolCatalogEntry, "name" | "category">): boolean {
  return isDefaultBasicTool(entry.name, entry.category);
}

/**
 * Mark permitted-but-not-bound tools so the prompt and `invoke_tool` can tell
 * them apart from a genuine denial. `provider_tool_limit` already covers cap
 * overflow, so it is left alone.
 */
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
    const disabled = disabledBuiltinCategories.has(category);
    entries.set(tool.name, toCatalogEntry(tool, {
      source: "builtin",
      category,
      capability: registeredCapability(tool.name) ?? "execute",
      group: registeredGroup(tool.name) ?? groupForCategory(category),
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
      credentials_required: meta?.credentials_required ?? [],
      status: "enabled",
      status_reason: null,
    }));
  }

  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
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

export interface ProviderToolLimitResult {
  toolPermissionMap: ToolCatalogEntry[];
  allowedToolNames: string[];
  omittedToolNames: string[];
}

export interface ProviderToolLimitOptions {
  candidateQuery?: string;
  preferredToolNames?: readonly string[];
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

function toCatalogEntry(
  tool: StructuredToolInterface,
  meta: {
    source: ToolSource;
    category: ToolCategory;
    capability: Capability;
    group: ToolGroup | undefined;
    mcp_server?: string | null;
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
    credentials_required: meta.credentials_required ?? [],
    status: meta.status,
    status_reason: meta.status_reason,
  };
}

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

// Filter built-in tools whose category is disabled in the toggle store.
// External + MCP tools are untouched (they have their own enable surfaces).
function applyCategoryToggles(tools: StructuredToolInterface[]): StructuredToolInterface[] {
  const disabled = disabledCategories();
  if (disabled.size === 0) return tools;
  return tools.filter((t) => {
    const cat = registeredCategory(t.name);
    if (!cat) return true; // not a built-in (or unregistered) → leave it
    return !disabled.has(cat);
  });
}

// Synchronous: built-in + external tools (no MCP). Used by GET /api/v1/tools
// and any code path that can't await.
export function getAllTools(policy?: ToolPolicy): StructuredToolInterface[] {
  const ext = loadExternal();
  return applyPolicy(
    [
      ...applyCategoryToggles(allBuiltins()),
      // External tools never pass through registerTools (they're not
      // stored in the builtin REGISTRY — no category/capability, no
      // duplicate-name bookkeeping) so they'd otherwise never get the
      // wallclock protection built-ins get for free. Wrap them here, at
      // the merge point, instead — same deadline_ms/async_run/stream
      // fields, just without the registry side-effects.
      ...ext.tools.filter((t) => !isDropinDisabled(t.name)).map(wrapWithWallclock),
    ],
    policy,
  );
}

// Async: built-in + external + MCP tools.
// Use this anywhere the agent might invoke tools (createReactAgent input).
// External tools are loaded per-call (hot-reload). MCP tools are cached by
// lib/mcp/client.ts and only re-resolved when the mcp_servers table changes.
// LangChain packages (lib/tools/langchain-packages.ts) are loaded once on
// first call and then live in the same registry as built-ins, so they flow
// through `allBuiltins()` automatically on subsequent calls.
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
      // Same reasoning as getAllTools above, extended to MCP: neither
      // external nor MCP tools ever go through registerTools, so without
      // this they'd run with no deadline at all — a single stuck MCP
      // server call or hung external tool could otherwise pin the turn
      // indefinitely (built-ins are protected; these weren't).
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
    if (cat && disabledCategories().has(cat)) {
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

  // Tools return JSON strings per LangChain convention; parse back for downstream use.
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }
  return result;
}

// One-shot startup loader. Call from instrumentation.ts so external tools
// load + log their status at boot rather than lazily on first agent turn.
let _initialized = false;
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

  if (!_initialized) {
    console.info(
      `[tools] ${summary.builtinCount} built-in tool(s) registered; ` +
      `${summary.externalCount} external tool(s) loaded from ${toolsDir}`,
    );
    for (const err of summary.errors) {
      console.error(`[tools] external ${err.file}: ${err.error}`);
    }
    _initialized = true;
  }
  return summary;
}
