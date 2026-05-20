// MCP server registry types + variable substitution.
//
// Discovery is online via the official MCP Registry (see
// `lib/mcp/upstream-registry.ts` and ADR-0013). Entries flow through this
// module's types so the picker UI, install action, and `applyVariables`
// substitution path stay decoupled from the upstream wire format.

export interface RegistryVariable {
  /** Unique key used as `${key}` in spec strings or env values. */
  key: string;
  /** Human-readable label shown in the form. */
  label: string;
  /** Placeholder text / example value. */
  placeholder?: string;
  /** If true, hide the field as a password. */
  secret?: boolean;
  /** Pre-filled default. User can edit. */
  default?: string;
}

export interface RegistryEntry {
  /** Slug used as the default MCP server name. */
  id: string;
  /** Display name in the picker. */
  name: string;
  /** One-line description. */
  description: string;
  /** Coarse grouping in the picker UI. */
  category: "Local" | "Web" | "Data" | "Productivity" | "Search" | "Cloud" | "Corporate";
  /** Author label (helps users gauge trust). */
  source: "Official" | "Community" | "Vendor";
  /** Homepage / docs URL — shown as a small "?" link in the picker. */
  url?: string;
  /** Transport. stdio runs a subprocess; http calls a remote SSE/HTTP MCP server. */
  transport: "stdio" | "http";
  /** Spec template. ${var} placeholders are replaced with user input. */
  spec: Record<string, unknown>;
  /** Optional ${} variables collected from the user before saving. */
  variables?: RegistryVariable[];
}

// Substitute `${var}` placeholders in a spec object using user-supplied values.
// Walks objects and arrays recursively; leaves non-strings alone.
export function applyVariables(
  spec: Record<string, unknown>,
  values: Record<string, string>,
): Record<string, unknown> {
  return walk(spec) as Record<string, unknown>;

  function walk(node: unknown): unknown {
    if (typeof node === "string") {
      return node.replace(/\$\{(\w+)\}/g, (_, k) => values[k] ?? `\${${k}}`);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return node;
  }
}
