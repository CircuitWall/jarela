/**
 * Tool registry.
 *
 * Each built-in tool module registers its own tools at module load with
 * two orthogonal axes:
 *
 *   - category   — topical group ("Memory", "Files", "Mail", …) used by
 *                  the Agent editor sidebar to organise tools for users.
 *   - capability — safety class ("read" | "write" | "execute") used by
 *                  the future per-capability approval gate, UI badges,
 *                  and the ADR-0037 output validator. See ADR-0038.
 *
 * `lib/tools/index.ts` only needs to side-effect-import the modules
 * (see ./builtins.ts) — there is no central map listing every tool by
 * name. Adding a new built-in tool now requires touching exactly two
 * files: the tool file itself, and an `import "./<name>";` line in
 * builtins.ts.
 *
 * External tools (loaded from JARELA_TOOLS_DIR at runtime) use the same
 * category vocabulary but are not stored in this registry — see
 * ./external.ts. MCP tools default to category "MCP". Both default to
 * capability "execute" until manifest-level overrides land (ADR-0038
 * follow-up).
 *
 * Public surface (per `package.json#exports`): `ToolCategory`,
 * `Capability`, `ToolGroup`, `BuiltinCategory`, `registerTools`.
 * Everything else (`registeredTools` / `registeredNames` /
 * `registeredCategory` / etc.) is `@internal` — used only by the in-tree
 * runtime, not part of the plugin contract.
 */

import type { StructuredToolInterface } from "@langchain/core/tools";
import { wrapWithWallclock } from "./wallclock";

export type ToolCategory =
  | "Memory" | "Documents" | "Files" | "Shell" | "Web" | "Images" | "Voice"
  | "Schedule" | "Atlassian" | "JiraAlign" | "GitHub" | "Mail" | "Calendar"
  | "Tasks" | "Microsoft" | "Config" | "Agent" | "MCP";

// Safety class. Orthogonal to ToolCategory. See ADR-0038 for definitions
// and tie-breakers (network reads vs writes, drafts, etc.).
export type Capability = "read" | "write" | "execute";

// Optional parent grouping for the Agent editor sidebar.
export type ToolGroup = "Work" | null;

// Runtime tuple of every built-in category (i.e. every `ToolCategory`
// except `"MCP"`). This is the single source of truth for anything that
// needs a runtime list of categories — API validation, `z.enum(...)`
// manifest schemas, UI dropdowns, etc. — so those surfaces can't drift
// away from `BuiltinCategory` and reject legitimate categories (as the
// `builtin-tools` PATCH route did before, rejecting `iCloud`).
export const BUILTIN_CATEGORIES = [
  "Memory", "Documents", "Files", "Shell", "Web", "Images", "Voice",
  "Schedule", "Atlassian", "JiraAlign", "GitHub", "Mail", "Calendar",
  "Tasks", "Microsoft", "Config", "Agent",
] as const satisfies readonly Exclude<ToolCategory, "MCP">[];

export type BuiltinCategory = (typeof BUILTIN_CATEGORIES)[number];

// Category → group mapping. "Work" collapses corporate-auth tools under
// one header in the Agent editor; everything else is a top-level category.
const CATEGORY_GROUPS: Record<Exclude<ToolCategory, "MCP">, ToolGroup> = {
  Memory: null, Documents: null, Files: null, Shell: null, Web: null, Images: null, Voice: null,
  Schedule: null, Config: null, Mail: null, Calendar: null, Agent: null,
  Atlassian: "Work", JiraAlign: "Work", GitHub: "Work", Tasks: "Work", Microsoft: "Work",
};

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
  const wrapped: T[] = [];
  for (const t of tools) {
    if (REGISTRY.has(t.name)) {
      throw new Error(`[tools] duplicate built-in tool registration: ${t.name}`);
    }
    // Every built-in tool gets the agent-controlled wall-clock wrap so a
    // single stuck call (network hang, fs on a wedged cloud-sync drive,
    // runaway shell) can't pin the turn — see lib/tools/wallclock.ts.
    const w = wrapWithWallclock(t);
    REGISTRY.set(w.name, { tool: w, category, capability, group });
    wrapped.push(w);
  }
  return wrapped;
}

/** @internal — all registered built-in tools, in registration order. */
export function registeredTools(): StructuredToolInterface[] {
  return Array.from(REGISTRY.values(), (e) => e.tool);
}

/**
 * Remove previously-registered tools by name. Returns the number of entries
 * actually removed. Used by the hot-load path
 * (`lib/tools/langchain-packages.ts`) when a package is reloaded or removed
 * — the in-tree side-effect-imported tools never call this.
 */
export function unregisterTools(names: Iterable<string>): number {
  let removed = 0;
  for (const name of names) {
    if (REGISTRY.delete(name)) removed += 1;
  }
  return removed;
}

/** @internal — names of all registered built-in tools, used for collision checks. */
export function registeredNames(): ReadonlySet<string> {
  return new Set(REGISTRY.keys());
}

/** @internal */
export function registeredCategory(name: string): BuiltinCategory | undefined {
  return REGISTRY.get(name)?.category;
}

/** @internal */
export function registeredCapability(name: string): Capability | undefined {
  return REGISTRY.get(name)?.capability;
}

/** @internal */
export function registeredGroup(name: string): ToolGroup | undefined {
  return REGISTRY.get(name)?.group;
}

/** @internal — test-only: clear the registry between cases. */
export function _resetRegistry(): void {
  REGISTRY.clear();
}
