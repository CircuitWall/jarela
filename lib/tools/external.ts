import { join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getConfig } from "@/lib/env/config";
import { getToolSecret, type ToolSecretSlot } from "@/lib/stores/tool-secrets";
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
  // Optional per-tool secret slots. Surfaced in the Extensions panel as
  // editable form fields; persisted (encrypted at rest) in the
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

export interface ExtensionLoadError {
  file: string;
  error: string;
}

export interface ExternalToolsResult {
  tools: StructuredToolInterface[];
  categories: Map<string, ToolCategory>;
  files: Map<string, string>;
  // Declared secret slots per tool name (empty array if the tool did not
  // declare any). Used by the Extensions panel to render input fields.
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

export function loadExternalTools(
  builtinNames: ReadonlySet<string>,
): ExternalToolsResult {
  const tools: StructuredToolInterface[] = [];
  const categories = new Map<string, ToolCategory>();
  const files = new Map<string, string>();
  const secrets = new Map<string, ToolSecretSlot[]>();
  const errors: ExtensionLoadError[] = [];

  const toolsDir = getToolsDir();
  if (!existsSync(toolsDir)) {
    return { tools, categories, files, secrets, errors };
  }

  // Same trick as lib/providers/external.ts: bypass webpack's static analysis
  // so the dynamic require survives the Next build.
  const { createRequire } = (
    process as unknown as { getBuiltinModule: (id: string) => typeof import("node:module") }
  ).getBuiltinModule("node:module");
  const req = createRequire(join(toolsDir, "_anchor"));

  let entries: string[];
  try {
    entries = readdirSync(toolsDir);
  } catch {
    return { tools, categories, files, secrets, errors };
  }

  const seen = new Set<string>();

  for (const entry of entries) {
    if (!/\.(c?js|ts)$/i.test(entry)) continue;
    const path = join(toolsDir, entry);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }

    let mod: unknown;
    try {
      delete req.cache[req.resolve(path)];
      mod = req(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ file: entry, error: message });
      console.error(`[tools] failed to load ${entry}:`, err);
      continue;
    }

    const candidate =
      (mod as { default?: unknown })?.default ?? (mod as unknown);
    if (!isValid(candidate)) {
      const msg =
        "does not export a valid ExternalToolDef (need { name, description, schema, run })";
      errors.push({ file: entry, error: msg });
      console.error(`[tools] ${entry} ${msg}`);
      continue;
    }

    const def = candidate;
    if (builtinNames.has(def.name)) {
      const msg = `name "${def.name}" collides with a built-in tool — built-in takes precedence`;
      errors.push({ file: entry, error: msg });
      console.warn(`[tools] external ${entry}: ${msg}`);
      continue;
    }
    if (seen.has(def.name)) {
      const msg = `duplicate external tool "${def.name}"`;
      errors.push({ file: entry, error: msg });
      console.warn(`[tools] ${entry}: ${msg}`);
      continue;
    }
    seen.add(def.name);

    const wrapped = tool(
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

    tools.push(wrapped);
    files.set(def.name, entry);
    if (def.category) categories.set(def.name, def.category);
    secrets.set(def.name, def.secrets ?? []);
  }

  return { tools, categories, files, secrets, errors };
}
