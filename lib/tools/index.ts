// Public tool surface for the agent runtime.
//
// Built-in tools register themselves at module load (see ./registry.ts and
// ./builtins.ts). External tools live under JARELA_TOOLS_DIR and are
// loaded per-call (hot-reload). MCP tools come from lib/mcp/client.ts.
//
// To add a new built-in tool:
//   1. Copy lib/tools/template.ts to lib/tools/<name>.ts and implement it.
//   2. Call `registerTools("<Category>", "<read|write|execute>", [yourTool, ...])` at the bottom.
//   3. Add `import "./<name>";` to lib/tools/builtins.ts.
//
// That's it — no central array to update, no parallel category map.

import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { RunnableConfig } from "@langchain/core/runnables";

// Side-effect import: triggers registerTools() in every built-in module.
import "./builtins";

import {
  registeredTools,
  registeredNames,
  registeredCategory,
  registeredCapability,
  registeredGroup,
  type Capability,
  type ToolCategory,
  type ToolGroup,
} from "./registry";
import { getMcpTools } from "@/lib/mcp/client";
import {
  loadExternalTools,
  getToolsDir,
  type ExtensionLoadError,
} from "./external";
import type { OpenAITool, ToolContext, ToolParamSchema } from "./types";
import type { ToolPolicy } from "@/lib/agents/base";
import { disabledCategories } from "@/lib/stores/builtin-tools";

export * from "./types";
export { getToolsDir, type ExtensionLoadError } from "./external";
export {
  registerTools,
  type Capability,
  type ToolCategory,
  type ToolGroup,
} from "./registry";

// Look up a tool's safety class. Built-in tools have a declared capability;
// external (JARELA_TOOLS_DIR) and MCP tools default to "execute" — the
// conservative choice until manifest-level overrides land (ADR-0038).
export function getToolCapability(name: string, source: "builtin" | "mcp"): Capability {
  const builtin = registeredCapability(name);
  if (builtin) return builtin;
  if (source === "mcp") return "execute";
  // External tool: same conservative default.
  return "execute";
}

const ALL_BUILTINS: StructuredToolInterface[] = registeredTools();
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = registeredNames();

// Per-call recompute so files dropped in $JARELA_TOOLS_DIR are picked up
// without restart. loadExternalTools cache-busts require() per file.
function loadExternal() {
  return loadExternalTools(BUILTIN_TOOL_NAMES);
}

export function getToolCategory(name: string, source: "builtin" | "mcp"): ToolCategory {
  const builtin = registeredCategory(name);
  if (builtin) return builtin;
  const ext = loadExternal().categories.get(name);
  if (ext) return ext;
  return source === "mcp" ? "MCP" : "Config";
}

export function getToolGroup(name: string, source: "builtin" | "mcp"): ToolGroup {
  const cat = getToolCategory(name, source);
  if (cat === "MCP") return null;
  return registeredGroup(name) ?? null;
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
  return applyPolicy(
    [...applyCategoryToggles(ALL_BUILTINS), ...loadExternal().tools],
    policy,
  );
}

// Async: built-in + external + MCP tools.
// Use this anywhere the agent might invoke tools (createReactAgent input).
// External tools are loaded per-call (hot-reload). MCP tools are cached by
// lib/mcp/client.ts and only re-resolved when the mcp_servers table changes.
export async function getAllToolsAsync(policy?: ToolPolicy): Promise<StructuredToolInterface[]> {
  let mcpTools: StructuredToolInterface[] = [];
  try {
    mcpTools = await getMcpTools();
  } catch (err) {
    console.error("[tools] MCP load failed, continuing with built-ins only:", err);
  }
  return applyPolicy(
    [...applyCategoryToggles(ALL_BUILTINS), ...loadExternal().tools, ...mcpTools],
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
  let t = ALL_BUILTINS.find((x) => x.name === name);
  if (t) {
    const cat = registeredCategory(name);
    if (cat && disabledCategories().has(cat)) {
      throw new Error(`Tool "${name}" is disabled (category ${cat} is turned off)`);
    }
  }
  if (!t) {
    t = loadExternal().tools.find((x) => x.name === name);
  }
  if (!t) throw new Error(`Unknown tool: ${name}`);

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
    builtinCount: ALL_BUILTINS.length,
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
