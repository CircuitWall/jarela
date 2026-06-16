/**
 * Hot-load vanilla LangChain tool packages from disk.
 *
 * Operator workflow (this PR's walking skeleton):
 *
 *   1. Create `$JARELA_PACKAGES_DIR` (default `~/.jarela/packages/`) with
 *      its own `package.json` and run `npm install <some-langchain-pkg>`
 *      inside it. Jarela does NOT shell out to npm.
 *   2. Drop a manifest file in `$JARELA_PACKAGES_DIR/manifests/*.json`
 *      describing which package + named export to load, what category and
 *      capability to file it under, and any constructor args.
 *   3. Either restart the server, or hit `POST /api/v1/packages/reload`
 *      to re-scan without restart. `GET /api/v1/packages` returns the
 *      loader's current state for introspection.
 *
 * What this loader does NOT do (deliberate, deferred to follow-up PRs):
 *
 *   - npm install / version management
 *   - UI form to edit manifests
 *   - Integrations-panel credential storage for packages whose
 *     constructors need API keys (env vars only for now — operators set
 *     `TAVILY_API_KEY` etc. in the process environment)
 *   - Sandbox / capability isolation (packages run with full Node trust,
 *     same as `$JARELA_TOOLS_DIR` extensions today)
 *
 * Manifest shape (zod-validated):
 *
 *   {
 *     "package": "@langchain/community/tools/tavily_search",
 *     "export": "TavilySearchResults",   // default: "default"
 *     "category": "Web",                  // BuiltinCategory
 *     "capability": "read",               // default: "execute"
 *     "args": { "maxResults": 5 },        // optional constructor args
 *     "requiredEnv": ["TAVILY_API_KEY"]   // optional; skips if any unset
 *   }
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  registerLangChainPackage,
  type RegisteredPackage,
} from "./langchain-package";
import { categorizeByVerb } from "./categorize-by-verb";
import { errorMessage } from "@/lib/utils/error";
import { isPackageDisabled } from "@/lib/stores/disabled-packages";
import { getInjectedSubprocessEnv } from "@/lib/env/allowlist";

export const BUILTIN_CATEGORIES = [
  "Memory", "Documents", "Files", "Shell", "Web", "Images", "Voice",
  "Schedule", "Atlassian", "JiraAlign", "GitHub", "Mail", "Calendar",
  "Tasks", "Config", "Agent",
] as const;

export const MANIFEST_SCHEMA = z.object({
  package: z.string().min(1),
  // `"*"` triggers wildcard discovery: every function-valued export of
  // the package is constructed (with and without `args`) and registered
  // if the resulting instance shapes up as a StructuredTool. Anything
  // else is treated as a named export.
  export: z.string().min(1).default("default"),
  category: z.enum(BUILTIN_CATEGORIES),
  // Optional: when omitted, the loader derives the capability from the
  // tool's verb (see lib/tools/categorize-by-verb.ts). Operators can
  // pin a value here when the verb is genuinely ambiguous.
  capability: z.enum(["read", "write", "execute"]).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  requiredEnv: z.array(z.string().min(1)).optional(),
});

export type LangChainPackageManifest = z.infer<typeof MANIFEST_SCHEMA>;

export interface LangChainPackageLoadError {
  manifest: string;
  error: string;
}

export interface LangChainPackageLoadResult {
  registered: string[];
  skipped: { manifest: string; reason: string }[];
  errors: LangChainPackageLoadError[];
}

export function getPackagesDir(): string {
  const raw = process.env.JARELA_PACKAGES_DIR;
  if (raw && raw.trim().length > 0) {
    return raw.startsWith("~") ? raw.replace(/^~/, homedir()) : raw;
  }
  return join(homedir(), ".jarela", "packages");
}

export function getManifestsDir(): string {
  return join(getPackagesDir(), "manifests");
}

const handles: RegisteredPackage<unknown>[] = [];
let cached: LangChainPackageLoadResult | null = null;
let inflight: Promise<LangChainPackageLoadResult> | null = null;

/**
 * Load + register every manifest under `$JARELA_PACKAGES_DIR/manifests/`.
 * Idempotent within a single process — subsequent calls return the cached
 * result. Use `_resetLangChainPackages()` (test-only) or
 * `reloadLangChainPackages()` to force a fresh load.
 */
export async function loadLangChainPackages(): Promise<LangChainPackageLoadResult> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = doLoad().finally(() => { inflight = null; });
  const result = await inflight;
  cached = result;
  return result;
}

/**
 * Unregister every currently-loaded package and reload from disk. Returns
 * the new load result. Wired in for a future reload endpoint; not yet
 * exposed via HTTP / UI.
 */
export async function reloadLangChainPackages(): Promise<LangChainPackageLoadResult> {
  for (const handle of handles.splice(0)) handle.unregister();
  cached = null;
  return loadLangChainPackages();
}

async function doLoad(): Promise<LangChainPackageLoadResult> {
  const packagesDir = getPackagesDir();
  const manifestsDir = getManifestsDir();
  const result: LangChainPackageLoadResult = {
    registered: [],
    skipped: [],
    errors: [],
  };

  if (!existsSync(manifestsDir)) return result;

  let entries: string[];
  try {
    entries = readdirSync(manifestsDir);
  } catch {
    return result;
  }

  // Resolve modules from inside the operator's packages dir so its
  // node_modules wins over Jarela's. Same trick as lib/tools/external.ts.
  const { createRequire } = (
    process as unknown as { getBuiltinModule: (id: string) => typeof import("node:module") }
  ).getBuiltinModule("node:module");
  const req = createRequire(join(packagesDir, "_anchor"));

  dedupeSharedDeps(req);

  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".json")) continue;
    const manifestPath = join(manifestsDir, entry);
    try {
      if (!statSync(manifestPath).isFile()) continue;
    } catch {
      continue;
    }

    // Honor the operator's per-manifest disable flag (set via
    // `setManifestEnabled` in lib/tools/package-manifests.ts). Skip
    // here rather than after parsing so a malformed manifest the user
    // already turned off doesn't get reported as a load error.
    const manifestName = entry.slice(0, -".json".length);
    if (isPackageDisabled(`npm:${manifestName}`)) {
      result.skipped.push({ manifest: entry, reason: "disabled by operator" });
      continue;
    }

    const loaded = await loadOneManifest(req, manifestPath, entry);
    if ("skip" in loaded) {
      result.skipped.push({ manifest: entry, reason: loaded.skip });
      continue;
    }
    if ("error" in loaded) {
      result.errors.push({ manifest: entry, error: loaded.error });
      console.error(`[langchain-packages] ${entry}: ${loaded.error}`);
      continue;
    }
    handles.push(loaded.handle as RegisteredPackage<unknown>);
    for (const toolName of loaded.toolNames) result.registered.push(toolName);
  }

  return result;
}

type ManifestOutcome =
  | { error: string }
  | { skip: string }
  | { handle: RegisteredPackage<unknown>; toolNames: string[] };

async function loadOneManifest(
  req: NodeJS.Require,
  manifestPath: string,
  entry: string,
): Promise<ManifestOutcome> {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    return { error: `unreadable manifest: ${errorMessage(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `invalid JSON: ${errorMessage(err)}` };
  }

  const validated = MANIFEST_SCHEMA.safeParse(parsed);
  if (!validated.success) {
    return { error: `schema validation failed: ${validated.error.message}` };
  }
  const manifest = validated.data;

  if (manifest.requiredEnv && manifest.requiredEnv.length > 0) {
    // Treat values held in the encrypted integration store (via the
    // env-sync allowlist) as satisfying the check, and surface them on
    // process.env so the LangChain constructor — which reads env vars
    // directly — picks them up. Mirrors how MCP children + local_exec
    // already inherit `getInjectedSubprocessEnv()`. Swallow store
    // errors (e.g. master key locked) so the loader still falls back
    // to the plain process.env check.
    let injected: Record<string, string> = {};
    try {
      injected = getInjectedSubprocessEnv();
    } catch { /* keep injected empty */ }
    for (const k of manifest.requiredEnv) {
      const current = process.env[k];
      if ((!current || current.trim() === "") && injected[k]) {
        process.env[k] = injected[k];
      }
    }
    const missing = manifest.requiredEnv.filter((k) => !process.env[k] || process.env[k]!.trim() === "");
    if (missing.length > 0) {
      return { skip: `required env not set: ${missing.join(", ")}` };
    }
  }

  let resolved: string;
  try {
    resolved = req.resolve(manifest.package);
  } catch (err) {
    return { error: `cannot resolve package "${manifest.package}": ${errorMessage(err)}` };
  }

  let mod: Record<string, unknown>;
  try {
    mod = loadResolvedModule(req, resolved);
  } catch (err) {
    return { error: `dynamic import failed: ${errorMessage(err)}` };
  }

  // Wildcard discovery: walk every function-valued export, try to
  // construct it, keep the ones that look like a StructuredTool. Lets
  // operators install a package like `@langchain/community/tools/tavily_search`
  // and pick up `TavilySearchResults` + `TavilyExtract` + ... without
  // authoring one manifest per export.
  if (manifest.export === "*") {
    return loadWildcardManifest(manifest, mod);
  }

  const exportName = manifest.export;
  const Ctor = mod[exportName];
  if (typeof Ctor !== "function") {
    return { error: `export "${exportName}" is not a function/constructor` };
  }

  let instance: unknown;
  try {
    instance = new (Ctor as new (args?: Record<string, unknown>) => unknown)(manifest.args);
  } catch (err) {
    return { error: `constructor threw: ${errorMessage(err)}` };
  }

  if (!isStructuredTool(instance)) {
    return { error: `export "${exportName}" did not produce a StructuredTool (missing name/description/schema/invoke)` };
  }

  const bucket: Record<"read" | "write" | "execute", StructuredToolInterface[]> = {
    read: [],
    write: [],
    execute: [],
  };
  // Manifest may pin the capability; otherwise auto-derive from the
  // tool's verb so operators don't have to classify every entry.
  const capability = manifest.capability ?? categorizeByVerb(instance.name);
  bucket[capability].push(instance);

  let handle: RegisteredPackage<unknown>;
  try {
    handle = registerLangChainPackage({
      category: manifest.category,
      tools: {
        read: bucket.read.length ? bucket.read : undefined,
        write: bucket.write.length ? bucket.write : undefined,
        execute: bucket.execute.length ? bucket.execute : undefined,
      },
    });
  } catch (err) {
    return { error: `registration failed: ${errorMessage(err)}` };
  }

  void entry;
  return { handle, toolNames: [instance.name] };
}

function loadWildcardManifest(
  manifest: LangChainPackageManifest,
  mod: Record<string, unknown>,
): ManifestOutcome {
  const bucket: Record<"read" | "write" | "execute", StructuredToolInterface[]> = {
    read: [],
    write: [],
    execute: [],
  };
  const seen = new Set<string>();
  const toolNames: string[] = [];

  for (const [exportName, value] of Object.entries(mod)) {
    if (typeof value !== "function") continue;
    let instance: unknown;
    // Try with args first (covers tools that need configuration), then
    // fall back to no-args (covers tools where args would throw).
    try {
      instance = new (value as new (a?: Record<string, unknown>) => unknown)(manifest.args);
    } catch {
      try {
        instance = new (value as new () => unknown)();
      } catch {
        continue;
      }
    }
    if (!isStructuredTool(instance)) continue;
    if (seen.has(instance.name)) continue;
    seen.add(instance.name);
    const capability = manifest.capability ?? categorizeByVerb(instance.name);
    bucket[capability].push(instance);
    toolNames.push(instance.name);
    void exportName;
  }

  if (toolNames.length === 0) {
    return {
      error: `wildcard import: no exports in "${manifest.package}" produced a StructuredTool`,
    };
  }

  let handle: RegisteredPackage<unknown>;
  try {
    handle = registerLangChainPackage({
      category: manifest.category,
      tools: {
        read: bucket.read.length ? bucket.read : undefined,
        write: bucket.write.length ? bucket.write : undefined,
        execute: bucket.execute.length ? bucket.execute : undefined,
      },
    });
  } catch (err) {
    return { error: `registration failed: ${errorMessage(err)}` };
  }

  return { handle, toolNames };
}

function isStructuredTool(v: unknown): v is StructuredToolInterface {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    o.name.length > 0 &&
    typeof o.description === "string" &&
    "schema" in o &&
    typeof o.invoke === "function"
  );
}

/**
 * Load a resolved-on-disk module into the loader's address space.
 *
 * Uses the manifest-anchored `createRequire` rather than `await
 * import(file://…)` because Next.js's server bundler intercepts dynamic
 * `import()` calls and cannot resolve a `file://` URL to an installed
 * module at runtime — the operator hits "Cannot find module
 * 'file:///…/wikipedia_query_run.cjs'" even when the file exists. On
 * Node 22.12+ / 24+ (Jarela targets Node 25) `require()` transparently
 * handles ESM modules too, so this single code path covers both .cjs
 * and "type": "module" packages.
 */
function loadResolvedModule(req: NodeJS.Require, resolved: string): Record<string, unknown> {
  const loaded = req(resolved) as Record<string, unknown> | { default?: Record<string, unknown> };
  // ESM modules required from CJS expose their named exports on the
  // returned namespace object directly, but some bundles only set
  // `default`. Merge so callers can read either shape.
  if (loaded && typeof loaded === "object" && "default" in loaded && loaded.default && typeof loaded.default === "object") {
    return { ...(loaded.default as Record<string, unknown>), ...loaded };
  }
  return loaded as Record<string, unknown>;
}

/** @internal — test-only: unregister every loaded tool and drop cache. */
export function _resetLangChainPackages(): void {
  for (const handle of handles.splice(0)) handle.unregister();
  cached = null;
  inflight = null;
}

/**
 * Packages that BOTH Jarela and operator-loaded LangChain packages
 * depend on. If Node's resolver lands on a different physical copy for
 * the operator package than for Jarela itself, `instanceof` checks
 * break across the boundary — e.g. a `ToolMessage` returned by an
 * operator tool fails `chunk instanceof ToolMessage` in `lib/agents/
 * llm.ts` because the two `ToolMessage` classes were evaluated from
 * different files. The tool_result chunk is then silently dropped and
 * the UI stalls on a "running" pill.
 *
 * Add packages here when they expose constructors that Jarela checks
 * with `instanceof` across the operator/host boundary.
 */
const SHARED_DEPS_TO_DEDUPE = ["@langchain/core"] as const;

/**
 * For every subpath export of each shared dependency, force operator
 * packages to use Jarela's physical copy instead of any stray copy
 * Node's parent-directory walk happened to land on. We do this by
 * pre-populating `require.cache` so the next `require("@langchain/
 * core/tools")` from operator code returns Jarela's already-evaluated
 * module object (same constructor identities).
 *
 * Idempotent: rerunning is a no-op once the aliases are in place.
 */
function dedupeSharedDeps(operatorReq: NodeJS.Require): void {
  const cache = (operatorReq as unknown as { cache: NodeJS.Dict<NodeJS.Module> }).cache;
  for (const pkg of SHARED_DEPS_TO_DEDUPE) {
    let pkgJson: { exports?: Record<string, unknown> };
    try {
      // Jarela's own resolution — this is the copy we want to win.
      pkgJson = require(`${pkg}/package.json`) as { exports?: Record<string, unknown> };
    } catch {
      continue;
    }
    const exportsField = pkgJson.exports;
    if (!exportsField || typeof exportsField !== "object") continue;

    for (const subpath of Object.keys(exportsField)) {
      if (subpath === "./package.json") continue;
      const modId = subpath === "." ? pkg : `${pkg}/${subpath.slice(2)}`;
      let operatorPath: string;
      let jarelaPath: string;
      try {
        operatorPath = operatorReq.resolve(modId);
      } catch {
        continue;
      }
      try {
        jarelaPath = require.resolve(modId);
      } catch {
        continue;
      }
      if (operatorPath === jarelaPath) continue;
      // Eagerly evaluate Jarela's copy so its module record sits in
      // require.cache, then alias the operator-resolved path to it.
      try {
        require(modId);
      } catch {
        continue;
      }
      const jarelaModule = require.cache[jarelaPath];
      if (jarelaModule) cache[operatorPath] = jarelaModule;
    }
  }
}
