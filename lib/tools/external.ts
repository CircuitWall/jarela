import { join } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getDataDir } from "@/lib/db/data-dir";
import type { ToolCategory } from "./index";

export const TOOLS_DIR = join(getDataDir(), "tools");

export interface ExternalToolDef {
  name: string;
  description: string;
  schema: object;
  category?: ToolCategory;
  run: (
    args: Record<string, unknown>,
    ctx: { thread_id?: string },
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
  errors: ExtensionLoadError[];
}

function isValid(p: unknown): p is ExternalToolDef {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    o.name.trim() !== "" &&
    typeof o.description === "string" &&
    typeof o.schema === "object" &&
    o.schema !== null &&
    typeof o.run === "function"
  );
}

export function loadExternalTools(
  builtinNames: ReadonlySet<string>,
): ExternalToolsResult {
  const tools: StructuredToolInterface[] = [];
  const categories = new Map<string, ToolCategory>();
  const files = new Map<string, string>();
  const errors: ExtensionLoadError[] = [];

  if (!existsSync(TOOLS_DIR)) {
    return { tools, categories, files, errors };
  }

  // Same trick as lib/providers/external.ts: bypass webpack's static analysis
  // so the dynamic require survives the Next build.
  const { createRequire } = (
    process as unknown as { getBuiltinModule: (id: string) => typeof import("node:module") }
  ).getBuiltinModule("node:module");
  const req = createRequire(join(TOOLS_DIR, "_anchor"));

  let entries: string[];
  try {
    entries = readdirSync(TOOLS_DIR);
  } catch {
    return { tools, categories, files, errors };
  }

  const seen = new Set<string>();

  for (const entry of entries) {
    if (!/\.(c?js|ts)$/i.test(entry)) continue;
    const path = join(TOOLS_DIR, entry);
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
  }

  return { tools, categories, files, errors };
}
