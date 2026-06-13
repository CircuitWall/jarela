import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getConfig } from "@/lib/env/config";
import { getToolSecret, type ToolSecretSlot } from "@/lib/stores/tool-secrets";
import {
  scanCjsPlugins,
  type PluginLoadError,
} from "@/lib/utils/cjs-plugin-loader";
import type { ToolCategory } from "./registry";

/**
 * Absolute path to the external tools directory. Resolved lazily from
 * `getConfig().toolsDir` so JARELA_TOOLS_DIR (and JARELA_DB_DIR fallback)
 * are honoured.
 */
export function getToolsDir(): string {
  return getConfig().toolsDir;
}

export interface ExternalToolDef {
  name: string;
  description: string;
  schema: object;
  category?: ToolCategory;
  // Optional per-tool secret slots. Surfaced in the Tools → Packages
  // panel as editable form fields; persisted (encrypted at rest) in the
  // `tool-secrets` memory namespace. Read at run time via `ctx.getSecret`.
  // See ADR-0023.
  secrets?: ToolSecretSlot[];
  run: (
    args: Record<string, unknown>,
    ctx: {
      thread_id?: string;
      // Returns the persisted secret for this tool's slot, or `null` if
      // it has not been configured. Always scoped to the current tool —
      // a tool cannot read another tool's secrets via this helper.
      getSecret: (key: string) => string | null;
    },
  ) => unknown | Promise<unknown>;
}

// Legacy alias — see lib/providers/external.ts.
export type ExtensionLoadError = PluginLoadError;

export interface ExternalToolsResult {
  tools: StructuredToolInterface[];
  categories: Map<string, ToolCategory>;
  files: Map<string, string>;
  // Declared secret slots per tool name (empty array if the tool did not
  // declare any). Used by the Tools → Packages panel to render input fields.
  secrets: Map<string, ToolSecretSlot[]>;
  errors: ExtensionLoadError[];
}

function isValidSlot(v: unknown): v is ToolSecretSlot {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.key !== "string" || !/^[a-z0-9_-]+$/i.test(o.key)) return false;
  if (o.label !== undefined && typeof o.label !== "string") return false;
  if (o.required !== undefined && typeof o.required !== "boolean") return false;
  if (o.description !== undefined && typeof o.description !== "string") return false;
  return true;
}

function isValid(p: unknown): p is ExternalToolDef {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  if (
    typeof o.name !== "string" ||
    o.name.trim() === "" ||
    typeof o.description !== "string" ||
    typeof o.schema !== "object" ||
    o.schema === null ||
    typeof o.run !== "function"
  ) return false;
  if (o.secrets !== undefined) {
    if (!Array.isArray(o.secrets)) return false;
    if (!o.secrets.every(isValidSlot)) return false;
  }
  return true;
}

function wrapExternalTool(def: ExternalToolDef): StructuredToolInterface {
  return tool(
    async (args: unknown, _runManager?: unknown, config?: RunnableConfig) => {
      const ctx = {
        thread_id: config?.configurable?.thread_id as string | undefined,
        getSecret: (key: string) => getToolSecret(def.name, key),
      };
      const result = await def.run(args as Record<string, unknown>, ctx);
      return typeof result === "string" ? result : JSON.stringify(result);
    },
    {
      name: def.name,
      description: def.description,
      schema: def.schema as never,
    },
  ) as unknown as StructuredToolInterface;
}

export function loadExternalTools(
  builtinNames: ReadonlySet<string>,
): ExternalToolsResult {
  const tools: StructuredToolInterface[] = [];
  const categories = new Map<string, ToolCategory>();
  const files = new Map<string, string>();
  const secrets = new Map<string, ToolSecretSlot[]>();

  const { defs, errors } = scanCjsPlugins<ExternalToolDef>({
    dir: getToolsDir(),
    builtins: builtinNames,
    validate: (mod) => (isValid(mod) ? mod : null),
    getName: (def) => def.name,
    kindLabel: "ExternalToolDef (need { name, description, schema, run })",
    logScope: "tools",
  });

  for (const { def, file } of defs) {
    tools.push(wrapExternalTool(def));
    files.set(def.name, file);
    if (def.category) categories.set(def.name, def.category);
    secrets.set(def.name, def.secrets ?? []);
  }

  return { tools, categories, files, secrets, errors };
}
