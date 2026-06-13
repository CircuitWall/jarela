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
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  registerLangChainPackage,
  type RegisteredPackage,
} from "./langchain-package";
import { categorizeByVerb } from "./categorize-by-verb";

export const BUILTIN_CATEGORIES = [
  "Memory", "Documents", "Files", "Shell", "Web", "Images", "Voice",
  "Schedule", "Atlassian", "JiraAlign", "GitHub", "Mail", "Calendar",
  "Config", "Agent",
] as const;

export const MANIFEST_SCHEMA = z.object({
  package: z.string().min(1),
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

  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".json")) continue;
    const manifestPath = join(manifestsDir, entry);
    try {
      if (!statSync(manifestPath).isFile()) continue;
    } catch {
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
    result.registered.push(loaded.toolName);
  }

  return result;
}

type ManifestOutcome =
  | { error: string }
  | { skip: string }
  | { handle: RegisteredPackage<unknown>; toolName: string };

async function loadOneManifest(
  req: NodeJS.Require,
  manifestPath: string,
  entry: string,
): Promise<ManifestOutcome> {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    return { error: `unreadable manifest: ${err instanceof Error ? err.message : String(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  const validated = MANIFEST_SCHEMA.safeParse(parsed);
  if (!validated.success) {
    return { error: `schema validation failed: ${validated.error.message}` };
  }
  const manifest = validated.data;

  if (manifest.requiredEnv && manifest.requiredEnv.length > 0) {
    const missing = manifest.requiredEnv.filter((k) => !process.env[k] || process.env[k]!.trim() === "");
    if (missing.length > 0) {
      return { skip: `required env not set: ${missing.join(", ")}` };
    }
  }

  let resolved: string;
  try {
    resolved = req.resolve(manifest.package);
  } catch (err) {
    return { error: `cannot resolve package "${manifest.package}": ${err instanceof Error ? err.message : String(err)}` };
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  } catch (err) {
    return { error: `dynamic import failed: ${err instanceof Error ? err.message : String(err)}` };
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
    return { error: `constructor threw: ${err instanceof Error ? err.message : String(err)}` };
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
    return { error: `registration failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  void entry;
  return { handle, toolName: instance.name };
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

/** @internal — test-only: unregister every loaded tool and drop cache. */
export function _resetLangChainPackages(): void {
  for (const handle of handles.splice(0)) handle.unregister();
  cached = null;
  inflight = null;
}
