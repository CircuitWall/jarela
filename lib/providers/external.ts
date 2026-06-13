import { join } from "node:path";
import type { ModelProvider } from "./types";
import { getDataDir } from "@/lib/db/data-dir";
import {
  scanCjsPlugins,
  type PluginLoadError,
} from "@/lib/utils/cjs-plugin-loader";

export const PROVIDERS_DIR = join(getDataDir(), "providers");

// Re-exported as the legacy alias so external API types (api/types.ts)
// keep working without churn. New code should reach for `PluginLoadError`
// from `@/lib/utils/cjs-plugin-loader`.
export type ExtensionLoadError = PluginLoadError;

export interface ExternalProvidersResult {
  providers: Record<string, ModelProvider>;
  files: Map<string, string>;
  errors: ExtensionLoadError[];
}

function isValid(p: unknown): p is ModelProvider {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return typeof o.name === "string" && typeof o.chat === "function";
}

export function loadExternalProvidersDetailed(
  builtins: ReadonlySet<string>,
): ExternalProvidersResult {
  const providers: Record<string, ModelProvider> = {};
  const files = new Map<string, string>();

  const { defs, errors } = scanCjsPlugins<ModelProvider>({
    dir: PROVIDERS_DIR,
    builtins,
    validate: (mod) => (isValid(mod) ? mod : null),
    getName: (p) => p.name,
    kindLabel: "ModelProvider (need { name, chat })",
    logScope: "providers",
  });

  for (const { def, file } of defs) {
    providers[def.name] = def;
    files.set(def.name, file);
  }

  return { providers, files, errors };
}

// Convenience for callers that only need the provider map (the existing
// pattern in lib/providers/index.ts).
export function loadExternalProviders(
  builtins: ReadonlySet<string>,
): Record<string, ModelProvider> {
  return loadExternalProvidersDetailed(builtins).providers;
}
