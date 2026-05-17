import { join } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import { createRequire } from "node:module";
import type { ModelProvider } from "./types";
import { getDataDir } from "@/lib/db/data-dir";

export const PROVIDERS_DIR = join(getDataDir(), "providers");

// Static argument so webpack's dependency analysis doesn't warn. The
// resolution base only matters for relative specifiers, which we never
// pass — entries are loaded via absolute `path` below.
const req = createRequire(import.meta.url);

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
