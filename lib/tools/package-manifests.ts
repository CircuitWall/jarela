/**
 * CRUD over manifest files under `$JARELA_PACKAGES_DIR/manifests/`.
 *
 * The on-disk shape (one JSON file per tool) is the same one the loader
 * in `langchain-packages.ts` reads. This module owns name normalization,
 * uniqueness, and zod validation so the operator (or UI) doesn't have to
 * touch the manifest JSON by hand.
 *
 * Persistence model is deliberately filesystem-only (no SQLite table) so
 * the manifests dir remains the single source of truth and operators
 * can edit / git-track / copy manifests without going through Jarela.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  BUILTIN_CATEGORIES,
  getManifestsDir,
  MANIFEST_SCHEMA,
  reloadLangChainPackages,
  type LangChainPackageLoadResult,
  type LangChainPackageManifest,
} from "./langchain-packages";
import {
  isPackageDisabled,
  setPackageDisabled,
} from "@/lib/stores/disabled-packages";

// Key under which a manifest's disabled state is recorded in the
// shared `disabled_packages` table. The `npm:` prefix keeps this
// namespace separate from default-package ids (`atlassian`, `github`,
// `jira_align`) so the two surfaces can't collide.
export function manifestDisableKey(name: string): string {
  return `npm:${name}`;
}

/** Is the given manifest currently disabled? */
export function isManifestDisabled(name: string): boolean {
  return isPackageDisabled(manifestDisableKey(name));
}

/**
 * The on-wire shape for `POST /api/v1/packages/manifests`. Strict
 * superset of `MANIFEST_SCHEMA` plus a `name` field that becomes the
 * filename (without `.json`).
 */
export const MANIFEST_INPUT_SCHEMA = z.object({
  name: z.string().min(1).max(64),
  package: z.string().min(1),
  export: z.string().min(1).optional(),
  category: z.enum(BUILTIN_CATEGORIES),
  capability: z.enum(["read", "write", "execute"]).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  requiredEnv: z.array(z.string().min(1)).optional(),
});

export type ManifestInput = z.infer<typeof MANIFEST_INPUT_SCHEMA>;

export interface ManifestRecord {
  name: string;
  manifest: LangChainPackageManifest;
  enabled: boolean;
}

/**
 * Normalize a freeform name into a safe filename token:
 * lowercase, ASCII letters/digits/`-`/`_` only, no leading/trailing
 * separators. Throws if normalization leaves nothing.
 */
export function normalizeManifestName(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (!slug) throw new Error("name must contain at least one alphanumeric character");
  return slug;
}

function ensureDir(): string {
  const dir = getManifestsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function manifestPath(name: string): string {
  return join(getManifestsDir(), `${name}.json`);
}

export function listManifests(): ManifestRecord[] {
  const dir = getManifestsDir();
  if (!existsSync(dir)) return [];
  const rows: ManifestRecord[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.toLowerCase().endsWith(".json")) continue;
    const name = entry.slice(0, -".json".length);
    try {
      const raw = readFileSync(join(dir, entry), "utf8");
      const parsed = MANIFEST_SCHEMA.safeParse(JSON.parse(raw));
      if (parsed.success) {
        rows.push({ name, manifest: parsed.data, enabled: !isManifestDisabled(name) });
      }
    } catch {
      // skip malformed file — the loader will surface it as an error
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

export function getManifest(name: string): ManifestRecord | null {
  const normalized = normalizeManifestName(name);
  const path = manifestPath(normalized);
  if (!existsSync(path)) return null;
  try {
    const parsed = MANIFEST_SCHEMA.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) return null;
    return { name: normalized, manifest: parsed.data, enabled: !isManifestDisabled(normalized) };
  } catch {
    return null;
  }
}

export interface CreateManifestResult {
  record: ManifestRecord;
  load: LangChainPackageLoadResult;
}

/**
 * Write a manifest file and trigger a reload so the new tool becomes
 * live without a restart. Throws on duplicate name (use `replace` to
 * overwrite intentionally).
 */
export async function createManifest(
  input: ManifestInput,
  opts: { replace?: boolean } = {},
): Promise<CreateManifestResult> {
  const validated = MANIFEST_INPUT_SCHEMA.parse(input);
  const name = normalizeManifestName(validated.name);

  ensureDir();
  const path = manifestPath(name);
  if (existsSync(path) && !opts.replace) {
    throw new Error(`manifest "${name}" already exists`);
  }

  const onDisk: LangChainPackageManifest = MANIFEST_SCHEMA.parse({
    package: validated.package,
    export: validated.export ?? "default",
    category: validated.category,
    capability: validated.capability ?? "execute",
    args: validated.args,
    requiredEnv: validated.requiredEnv,
  });
  writeFileSync(path, JSON.stringify(onDisk, null, 2));
  const load = await reloadLangChainPackages();
  return {
    record: { name, manifest: onDisk, enabled: !isManifestDisabled(name) },
    load,
  };
}

export interface SetManifestEnabledResult {
  record: ManifestRecord;
  load: LangChainPackageLoadResult;
}

/**
 * Toggle whether a manifest is wired into the live registry. Persists
 * the flag in `disabled_packages` (namespaced via `manifestDisableKey`)
 * and reloads so the change takes effect without a restart.
 */
export async function setManifestEnabled(
  name: string,
  enabled: boolean,
): Promise<SetManifestEnabledResult> {
  const normalized = normalizeManifestName(name);
  const path = manifestPath(normalized);
  if (!existsSync(path)) {
    throw new Error(`manifest "${normalized}" not found`);
  }
  setPackageDisabled(manifestDisableKey(normalized), !enabled);
  const load = await reloadLangChainPackages();
  const record = getManifest(normalized);
  if (!record) {
    throw new Error(`manifest "${normalized}" disappeared during reload`);
  }
  return { record, load };
}

export async function deleteManifest(
  name: string,
): Promise<{ removed: boolean; load: LangChainPackageLoadResult }> {
  const normalized = normalizeManifestName(name);
  const path = manifestPath(normalized);
  if (!existsSync(path)) {
    return { removed: false, load: await reloadLangChainPackages() };
  }
  rmSync(path, { force: true });
  // Clean the disabled flag too so a future re-install with the same
  // name starts enabled by default.
  setPackageDisabled(manifestDisableKey(normalized), false);
  const load = await reloadLangChainPackages();
  return { removed: true, load };
}

/** @internal — test-only. */
export function _wipeManifests(): void {
  const dir = getManifestsDir();
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (!entry.toLowerCase().endsWith(".json")) continue;
    try { rmSync(join(dir, entry), { force: true }); } catch { /* ignore */ }
  }
}
