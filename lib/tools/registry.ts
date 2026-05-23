// Tool registry.
//
// Each built-in tool module registers its own tools + category at module
// load. lib/tools/index.ts only needs to side-effect-import the modules
// (see ./builtins.ts) — there is no central map listing every tool by
// name. Adding a new built-in tool now requires touching exactly two
// files: the tool file itself, and an `import "./<name>";` line in
// builtins.ts.
//
// External tools (loaded from JARELA_TOOLS_DIR at runtime) use the same
// category vocabulary but are not stored in this registry — see
// ./external.ts. MCP tools default to category "MCP".

import type { StructuredToolInterface } from "@langchain/core/tools";

export type ToolCategory =
  | "Memory" | "Files" | "Shell" | "Web" | "Images" | "Voice"
  | "Schedule" | "Atlassian" | "JiraAlign" | "GitHub" | "Mail" | "Calendar" | "Config" | "MCP";

// Optional parent grouping for the Agent editor sidebar.
export type ToolGroup = "Work" | null;

// Category → group mapping. "Work" collapses corporate-auth tools under
// one header in the Agent editor; everything else is a top-level category.
const CATEGORY_GROUPS: Record<Exclude<ToolCategory, "MCP">, ToolGroup> = {
  Memory: null, Files: null, Shell: null, Web: null, Images: null, Voice: null,
  Schedule: null, Config: null, Mail: null, Calendar: null,
  Atlassian: "Work", JiraAlign: "Work", GitHub: "Work",
};

export type BuiltinCategory = Exclude<ToolCategory, "MCP">;

interface RegistryEntry {
  tool: StructuredToolInterface;
  category: BuiltinCategory;
  group: ToolGroup;
}

const REGISTRY = new Map<string, RegistryEntry>();

/**
 * Register one or more tools under a category. Call this at the bottom of
 * each tool file (after the tools are defined). Throws on duplicate names
 * — collisions are bugs, not warnings.
 */
export function registerTools<T extends StructuredToolInterface>(
  category: BuiltinCategory,
  tools: readonly T[],
): readonly T[] {
  const group = CATEGORY_GROUPS[category];
  for (const t of tools) {
    if (REGISTRY.has(t.name)) {
      throw new Error(`[tools] duplicate built-in tool registration: ${t.name}`);
    }
    REGISTRY.set(t.name, { tool: t, category, group });
  }
  return tools;
}

/** All registered built-in tools, in registration order. */
export function registeredTools(): StructuredToolInterface[] {
  return Array.from(REGISTRY.values(), (e) => e.tool);
}

/** Names of all registered built-in tools — used for collision checks. */
export function registeredNames(): ReadonlySet<string> {
  return new Set(REGISTRY.keys());
}

export function registeredCategory(name: string): BuiltinCategory | undefined {
  return REGISTRY.get(name)?.category;
}

export function registeredGroup(name: string): ToolGroup | undefined {
  return REGISTRY.get(name)?.group;
}

/** Test-only: clear the registry between cases. */
export function _resetRegistry(): void {
  REGISTRY.clear();
}
