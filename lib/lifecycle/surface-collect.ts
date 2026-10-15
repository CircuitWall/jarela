/**
 * Collects the live model-facing surface (see surface-snapshot.ts). Imports
 * the agent runtime, so callers must point JARELA_DB_DIR at a scratch
 * directory first. Used only by the release changeset generator and its
 * tests — never by the running app.
 */
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { allBuiltins } from "@/lib/tools";
import { listStaticPrompts } from "@/lib/agents/prompt-registry";
import { buildVariants } from "@/lib/agents/prompt-variants";
import {
  SURFACE_SNAPSHOT_SCHEMA_VERSION,
  splitSystemPromptSections,
  type SurfacePrompt,
  type SurfaceSnapshot,
  type SurfaceTool,
} from "./surface-snapshot";

const SYSTEM_PROMPT_SOURCE = "lib/agents/prepare/system-prompt.ts";
/** Richest variant first so shared sections keep their fullest form. */
const VARIANT_PRIORITY = ["pinned-tools-all-bound", "delivery-channel", "proxy-only-and-provider-cap", "minimal-agent"];

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

export async function collectSurfaceSnapshot(version: string): Promise<SurfaceSnapshot> {
  const prompts: Record<string, SurfacePrompt> = {};
  for (const prompt of listStaticPrompts()) {
    prompts[`static.${prompt.id}`] = { source: prompt.source, text: prompt.text };
  }

  const variants = await buildVariants();
  const rank = (id: string) => {
    const index = VARIANT_PRIORITY.indexOf(id);
    return index === -1 ? VARIANT_PRIORITY.length : index;
  };
  for (const variant of [...variants].sort((a, b) => rank(a.id) - rank(b.id))) {
    for (const [title, text] of Object.entries(splitSystemPromptSections(variant.prompt))) {
      prompts[`system.${title}`] ??= { source: SYSTEM_PROMPT_SOURCE, text };
    }
  }

  const tools: Record<string, SurfaceTool> = {};
  for (const tool of allBuiltins()) {
    let parameters: unknown;
    try {
      parameters = toJsonSchema(tool.schema as Parameters<typeof toJsonSchema>[0]);
    } catch {
      parameters = {};
    }
    if (parameters && typeof parameters === "object") {
      delete (parameters as Record<string, unknown>).$schema;
    }
    tools[tool.name] = { description: tool.description ?? "", parameters };
  }

  return {
    schema_version: SURFACE_SNAPSHOT_SCHEMA_VERSION,
    version,
    prompts: sortedRecord(prompts),
    tools: sortedRecord(tools),
  };
}
