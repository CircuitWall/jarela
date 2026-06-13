/**
 * Shared CommonJS plugin loader.
 *
 * Both `lib/providers/external.ts` (drop-in `ModelProvider` files) and
 * `lib/tools/external.ts` (drop-in `ExternalToolDef` files) used to
 * implement the same scan-a-directory-of-`.cjs`-files dance by hand:
 *
 *   - resolve `node:module.createRequire` via `process.getBuiltinModule`
 *     so webpack/Next can't tree-shake it,
 *   - anchor the require at `<dir>/_anchor` so operator's local
 *     `node_modules/` wins over Jarela's bundled deps,
 *   - filter `.c?js|ts$` entries that are real files,
 *   - cache-bust per scan so saved edits show up without a restart,
 *   - validate the loaded module via a domain-specific predicate,
 *   - reject duplicates and built-in name collisions.
 *
 * This module owns the boilerplate. Domain-specific logic (the
 * predicate, the name extractor, the kind label used in error
 * messages) is parameterized.
 */
import { join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";

export interface PluginLoadError {
  file: string;
  error: string;
}

export interface PluginScanOptions<T> {
  /** Absolute directory to scan. May not exist yet — that yields zero results. */
  dir: string;
  /** Names that already belong to built-in objects of the same kind. */
  builtins: ReadonlySet<string>;
  /**
   * Validate a loaded module. Return the validated object on success,
   * or `null` to skip with a generic "invalid shape" error. Throw to
   * surface a custom error message via `error.message`.
   */
  validate: (mod: unknown) => T | null;
  /** Extract the unique name of a validated object. */
  getName: (def: T) => string;
  /** Human-readable kind for the generic invalid-shape error message. */
  kindLabel: string;
  /** Console-prefix scope, e.g. `"providers"` / `"tools"`. */
  logScope: string;
}

export interface PluginScanResult<T> {
  defs: Array<{ def: T; file: string }>;
  errors: PluginLoadError[];
}

/**
 * Scan a directory for CJS plugin files, validate each, and return the
 * good ones plus per-file errors. Idempotent — safe to call on every
 * request; entries cache-bust on each call.
 */
export function scanCjsPlugins<T>(opts: PluginScanOptions<T>): PluginScanResult<T> {
  const { dir, builtins, validate, getName, kindLabel, logScope } = opts;
  const defs: Array<{ def: T; file: string }> = [];
  const errors: PluginLoadError[] = [];
  if (!existsSync(dir)) return { defs, errors };

  // Reach for node:module via process.getBuiltinModule so webpack cannot
  // see the dependency and tree-shake it. Anchor to a real on-disk path
  // (not import.meta.url, which is rewritten to a virtual chunk URL).
  const { createRequire } = (
    process as unknown as { getBuiltinModule: (id: string) => typeof import("node:module") }
  ).getBuiltinModule("node:module");
  const req = createRequire(join(dir, "_anchor"));

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { defs, errors };
  }

  const seen = new Set<string>();

  for (const entry of entries) {
    if (!/\.(c?js|ts)$/i.test(entry)) continue;
    const path = join(dir, entry);
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
      console.error(`[${logScope}] failed to load ${entry}:`, err);
      continue;
    }

    const candidate = (mod as { default?: unknown })?.default ?? (mod as unknown);
    let def: T | null;
    try {
      def = validate(candidate);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ file: entry, error: msg });
      console.error(`[${logScope}] ${entry}: ${msg}`);
      continue;
    }
    if (def === null) {
      const msg = `does not export a valid ${kindLabel}`;
      errors.push({ file: entry, error: msg });
      console.error(`[${logScope}] ${entry} ${msg}`);
      continue;
    }

    const name = getName(def);
    if (builtins.has(name)) {
      const msg = `name "${name}" collides with a built-in ${logScope.replace(/s$/, "")} — built-in takes precedence`;
      errors.push({ file: entry, error: msg });
      console.warn(`[${logScope}] external ${entry}: ${msg}`);
      continue;
    }
    if (seen.has(name)) {
      const msg = `duplicate external ${logScope.replace(/s$/, "")} "${name}"`;
      errors.push({ file: entry, error: msg });
      console.warn(`[${logScope}] ${entry}: ${msg}`);
      continue;
    }
    seen.add(name);
    defs.push({ def, file: entry });
  }

  return { defs, errors };
}
