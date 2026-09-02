import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getConfig } from "@/lib/env/config";
import { createKeyedCache } from "@/lib/cache/keyed-cache";
import { getToolSecret, type ToolSecretSlot } from "@/lib/stores/tool-secrets";
import { getToolConfig, type ToolConfigSlot } from "@/lib/stores/tool-config";
import {
  scanCjsPlugins,
  type PluginLoadError,
} from "@/lib/utils/cjs-plugin-loader";
import type { ToolCategory } from "./registry";

export type { ToolConfigSlot };

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
  /**
   * Credential keys the tool needs before it can run (e.g. `["api_key"]`).
   * Surfaced as a key icon in the agent config panel so users know they must
   * configure the credential before enabling the tool.
   */
  credentials_required?: string[];
  /** INTEGRATIONS key backing this tool, so the catalog can hide it when unconfigured. */
  integration?: string;
  // Optional per-tool secret slots. Surfaced in the Tools → Packages
  // panel as editable form fields; persisted (encrypted at rest) in the
  // `tool-secrets` memory namespace. Read at run time via `ctx.getSecret`.
  // See ADR-0023.
  secrets?: ToolSecretSlot[];
  // Optional non-secret configuration slots. Surfaced as plain text/number/
  // boolean fields in the Tools → Packages panel; stored unencrypted in the
  // `tool-config` memory namespace. Read at run time via `ctx.getConfig`.
  config?: ToolConfigSlot[];
  run: (
    args: Record<string, unknown>,
    ctx: {
      thread_id?: string;
      // Returns the persisted secret for this tool's slot, or `null` if
      // it has not been configured. Always scoped to the current tool.
      getSecret: (key: string) => string | null;
      // Returns the persisted config value for this tool's slot, or `null`
      // if it has not been configured. Always scoped to the current tool.
      getConfig: (key: string) => string | null;
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
  // Declared config slots per tool name (empty array if the tool did not
  // declare any). Used by the Tools → Packages panel to render input fields.
  configs: Map<string, ToolConfigSlot[]>;
  // Credential keys required by each tool (empty if none declared).
  credentialsRequired: Map<string, string[]>;
  // Backing integration id per tool, when declared.
  integrations: Map<string, string>;
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

const CONFIG_TYPES = new Set(["string", "number", "boolean"]);

function isValidConfigSlot(v: unknown): v is ToolConfigSlot {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.key !== "string" || !/^[a-z0-9_-]+$/i.test(o.key)) return false;
  if (!CONFIG_TYPES.has(o.type as string)) return false;
  if (o.label !== undefined && typeof o.label !== "string") return false;
  if (o.required !== undefined && typeof o.required !== "boolean") return false;
  if (o.default !== undefined && typeof o.default !== "string") return false;
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
  if (o.config !== undefined) {
    if (!Array.isArray(o.config)) return false;
    if (!o.config.every(isValidConfigSlot)) return false;
  }
  if (o.credentials_required !== undefined) {
    if (!Array.isArray(o.credentials_required)) return false;
    if (!(o.credentials_required as unknown[]).every((c) => typeof c === "string")) return false;
  }
  if (o.integration !== undefined && typeof o.integration !== "string") return false;
  return true;
}

function wrapExternalTool(def: ExternalToolDef): StructuredToolInterface {
  return tool(
    async (args: unknown, _runManager?: unknown, config?: RunnableConfig) => {
      const ctx = {
        thread_id: config?.configurable?.thread_id as string | undefined,
        getSecret: (key: string) => getToolSecret(def.name, key),
        getConfig: (key: string) => getToolConfig(def.name, key),
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

// Short-lived cache so multiple per-tool metadata accessors in a single
// GET /api/v1/tools response share one filesystem scan instead of each
// triggering a full readdirSync + require() sweep. 5 s covers the entire
// request cycle while still picking up new tool files within seconds.
// Keyed on the tools dir so pointing JARELA_TOOLS_DIR elsewhere takes effect
// at once; `builtinNames` is process-stable and deliberately not part of it.
let _builtinNamesForLoad: ReadonlySet<string> = new Set();

const externalCache = createKeyedCache<ExternalToolsResult>({
  ttlMs: 5_000,
  key: () => getToolsDir(),
  load: () => scanExternalTools(_builtinNamesForLoad),
});

/** @internal — reset the scan cache between tests. */
export function _resetExternalCache(): void { externalCache.invalidate(); }

export function loadExternalTools(
  builtinNames: ReadonlySet<string>,
): ExternalToolsResult {
  _builtinNamesForLoad = builtinNames;
  return externalCache.get();
}

function scanExternalTools(builtinNames: ReadonlySet<string>): ExternalToolsResult {
  const tools: StructuredToolInterface[] = [];
  const categories = new Map<string, ToolCategory>();
  const files = new Map<string, string>();
  const secrets = new Map<string, ToolSecretSlot[]>();
  const configs = new Map<string, ToolConfigSlot[]>();
  const credentialsRequired = new Map<string, string[]>();
  const integrations = new Map<string, string>();

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
    configs.set(def.name, def.config ?? []);
    if (def.credentials_required?.length) credentialsRequired.set(def.name, def.credentials_required);
    if (def.integration) integrations.set(def.name, def.integration);
  }

  return { tools, categories, files, secrets, configs, credentialsRequired, integrations, errors };
}
