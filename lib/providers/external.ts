import { join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import type { ModelProvider } from "./types";
import { getDataDir } from "@/lib/db/data-dir";

export const PROVIDERS_DIR = join(getDataDir(), "providers");

export interface ExtensionLoadError {
  file: string;
  error: string;
}

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
  const errors: ExtensionLoadError[] = [];
  if (!existsSync(PROVIDERS_DIR)) return { providers, files, errors };

  // Reach for node:module via process.getBuiltinModule so webpack cannot
  // see the dependency and tree-shake it. With a normal `import { createRequire }
  // from "node:module"`, Next/webpack drops the call entirely (the result is
  // judged side-effect-free), leaving the require binding undefined at runtime.
  // process.getBuiltinModule is a Node 22+ API that bypasses both the module
  // graph and webpack's static analysis. Anchor to a real on-disk path — not
  // import.meta.url, which is rewritten to a virtual chunk URL that would
  // route absolute requires back through webpack's resolver.
  const { createRequire } = (
    process as unknown as { getBuiltinModule: (id: string) => typeof import("node:module") }
  ).getBuiltinModule("node:module");
  const req = createRequire(join(PROVIDERS_DIR, "_anchor"));

  let entries: string[];
  try {
    entries = readdirSync(PROVIDERS_DIR);
  } catch {
    return { providers, files, errors };
  }

  for (const entry of entries) {
    if (!/\.(c?js|ts)$/i.test(entry)) continue;
    const path = join(PROVIDERS_DIR, entry);
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
      console.error(`[providers] failed to load ${entry}:`, err);
      continue;
    }

    const candidate =
      (mod as { default?: unknown })?.default ?? (mod as unknown);
    if (!isValid(candidate)) {
      const msg = "does not export a valid ModelProvider (need { name, chat })";
      errors.push({ file: entry, error: msg });
      console.error(`[providers] ${entry} ${msg}`);
      continue;
    }

    const name = candidate.name;
    if (builtins.has(name)) {
      const msg = `name "${name}" collides with a built-in provider — built-in takes precedence`;
      errors.push({ file: entry, error: msg });
      console.warn(`[providers] external ${entry}: ${msg}`);
      continue;
    }
    if (providers[name]) {
      const msg = `duplicate external provider "${name}"`;
      errors.push({ file: entry, error: msg });
      console.warn(`[providers] ${entry}: ${msg}`);
      continue;
    }
    providers[name] = candidate;
    files.set(name, entry);
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
