import { join } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import type { ModelProvider } from "./types";
import { getDataDir } from "@/lib/db/data-dir";

export const PROVIDERS_DIR = join(getDataDir(), "providers");

function isValid(p: unknown): p is ModelProvider {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return typeof o.name === "string" && typeof o.chat === "function";
}

export function loadExternalProviders(
  builtins: ReadonlySet<string>,
): Record<string, ModelProvider> {
  const out: Record<string, ModelProvider> = {};
  if (!existsSync(PROVIDERS_DIR)) return out;

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
    return out;
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
      console.error(`[providers] failed to load ${entry}:`, err);
      continue;
    }

    const candidate =
      (mod as { default?: unknown })?.default ?? (mod as unknown);
    if (!isValid(candidate)) {
      console.error(
        `[providers] ${entry} does not export a valid ModelProvider (need { name, chat })`,
      );
      continue;
    }

    const name = candidate.name;
    if (builtins.has(name)) {
      console.warn(
        `[providers] external "${name}" from ${entry} ignored — built-in takes precedence`,
      );
      continue;
    }
    if (out[name]) {
      console.warn(
        `[providers] duplicate external provider "${name}" in ${entry} ignored`,
      );
      continue;
    }
    out[name] = candidate;
  }

  return out;
}
