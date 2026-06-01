// Tool registry.
//
// Each built-in tool module registers its own tools at module load with
// two orthogonal axes:
//
//   * category   — topical group ("Memory", "Files", "Mail", …) used by
//                  the Agent editor sidebar to organise tools for users.
//   * capability — safety class ("read" | "write" | "execute") used by
//                  the future per-capability approval gate, UI badges,
//                  and the ADR-0037 output validator. See ADR-0038.
//
// lib/tools/index.ts only needs to side-effect-import the modules
// (see ./builtins.ts) — there is no central map listing every tool by
// name. Adding a new built-in tool now requires touching exactly two
// files: the tool file itself, and an `import "./<name>";` line in
// builtins.ts.
//
// External tools (loaded from JARELA_TOOLS_DIR at runtime) use the same
// category vocabulary but are not stored in this registry — see
// ./external.ts. MCP tools default to category "MCP". Both default to
// capability "execute" until manifest-level overrides land (ADR-0038
// follow-up).

import type { StructuredToolInterface } from "@langchain/core/tools";

export type ToolCategory =
  | "Memory" | "Documents" | "Files" | "Shell" | "Web" | "Images" | "Voice"
  | "Schedule" | "Atlassian" | "JiraAlign" | "GitHub" | "Mail" | "Calendar" | "Config" | "Agent" | "MCP";

// Safety class. Orthogonal to ToolCategory. See ADR-0038 for definitions
// and tie-breakers (network reads vs writes, drafts, etc.).
export type Capability = "read" | "write" | "execute";

// Optional parent grouping for the Agent editor sidebar.
export type ToolGroup = "Work" | null;

// Category → group mapping. "Work" collapses corporate-auth tools under
// one header in the Agent editor; everything else is a top-level category.
const CATEGORY_GROUPS: Record<Exclude<ToolCategory, "MCP">, ToolGroup> = {
  Memory: null, Documents: null, Files: null, Shell: null, Web: null, Images: null, Voice: null,
  Schedule: null, Config: null, Mail: null, Calendar: null, Agent: null,
  Atlassian: "Work", JiraAlign: "Work", GitHub: "Work",
};

export type BuiltinCategory = Exclude<ToolCategory, "MCP">;

interface RegistryEntry {
  tool: StructuredToolInterface;
  category: BuiltinCategory;
  capability: Capability;
  group: ToolGroup;
}

const REGISTRY = new Map<string, RegistryEntry>();

/**
 * Register one or more tools under a category and capability. Call this at
 * the bottom of each tool file (after the tools are defined). Files with
 * mixed capabilities make multiple calls — see ADR-0038. Throws on
 * duplicate names — collisions are bugs, not warnings.
 */
export function registerTools<T extends StructuredToolInterface>(
  category: BuiltinCategory,
  capability: Capability,
  tools: readonly T[],
): readonly T[] {
  const group = CATEGORY_GROUPS[category];
  for (const t of tools) {
    if (REGISTRY.has(t.name)) {
      throw new Error(`[tools] duplicate built-in tool registration: ${t.name}`);
    }
    REGISTRY.set(t.name, { tool: t, category, capability, group });
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

export function registeredCapability(name: string): Capability | undefined {
  return REGISTRY.get(name)?.capability;
}

export function registeredGroup(name: string): ToolGroup | undefined {
  return REGISTRY.get(name)?.group;
}

/** Test-only: clear the registry between cases. */
export function _resetRegistry(): void {
  REGISTRY.clear();
}
