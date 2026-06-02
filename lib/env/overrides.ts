// Persistent env-var overrides written to ~/.jarela/env-overrides.json
// (or $JARELA_DB_DIR/env-overrides.json). Read once at boot and injected
// into process.env before any module reads its config. Mutated at runtime
// by /api/v1/env PATCH/DELETE; a hot-reload path resets the config cache
// so non-restart-required vars take effect immediately.
//
// Format: a flat JSON object of `JARELA_*` → string. Anything not in
// ENV_SCHEMA is rejected at write time (no free-form keys).

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "@/lib/db/data-dir";
import { envSchemaByName, type EnvVarDef } from "./schema";

const FILE_NAME = "env-overrides.json";

function overridesPath(): string {
  return join(getDataDir(), FILE_NAME);
}

export interface OverridesFile {
  readonly version: 1;
  readonly entries: Readonly<Record<string, string>>;
}

const EMPTY: OverridesFile = { version: 1, entries: {} };

export async function readOverrides(): Promise<OverridesFile> {
  try {
    const raw = await fs.readFile(overridesPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<OverridesFile>;
    if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
      // Defensive: keep only entries the current schema knows about.
      // Schema renames / removals should silently drop stale rows rather
      // than block boot.
      const known = envSchemaByName();
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (typeof v !== "string") continue;
        if (!known.has(k)) continue;
        filtered[k] = v;
      }
      return { version: 1, entries: filtered };
    }
    return EMPTY;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return EMPTY;
    // Corrupt file — log + ignore. Don't kill boot over a bad overrides
    // file; the operator can delete it and restart.
    console.warn(`[env-overrides] failed to read ${overridesPath()}: ${e.message}`);
    return EMPTY;
  }
}

export function readOverridesSync(): OverridesFile {
  // Sync read for the boot path, where async would force callers up the
  // module chain to await. Used exactly once in instrumentation-node.
  const fsSync = require("node:fs") as typeof import("node:fs");
  try {
    const raw = fsSync.readFileSync(overridesPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<OverridesFile>;
    if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
      const known = envSchemaByName();
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (typeof v !== "string") continue;
        if (!known.has(k)) continue;
        filtered[k] = v;
      }
      return { version: 1, entries: filtered };
    }
    return EMPTY;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return EMPTY;
    console.warn(`[env-overrides] failed to read ${overridesPath()}: ${e.message}`);
    return EMPTY;
  }
}

export async function writeOverrides(next: OverridesFile): Promise<void> {
  const path = overridesPath();
  const known = envSchemaByName();
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(next.entries)) {
    if (typeof v !== "string") continue;
    if (!known.has(k)) {
      throw new Error(`unknown env var: ${k}`);
    }
    filtered[k] = v;
  }
  const out: OverridesFile = { version: 1, entries: filtered };
  // Validate every entry against its schema before persisting; refuse
  // bad values at write time so we never write garbage that boot would
  // then have to reject silently.
  for (const [name, value] of Object.entries(filtered)) {
    const def = known.get(name);
    if (!def) continue;
    const err = validateForSchema(def, value);
    if (err) throw new Error(`${name}: ${err}`);
  }
  await fs.mkdir(join(path, ".."), { recursive: true });
  await fs.writeFile(path, JSON.stringify(out, null, 2) + "\n", "utf8");
}

export function validateForSchema(def: EnvVarDef, value: string): string | null {
  if (def.type === "int") {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return "expected integer";
    if (def.min !== undefined && n < def.min) return `minimum is ${def.min}`;
    if (def.max !== undefined && n > def.max) return `maximum is ${def.max}`;
    return null;
  }
  if (def.type === "bool") {
    if (!/^(0|1|true|false)$/i.test(value.trim())) return "expected bool (0/1/true/false)";
    return null;
  }
  if (def.type === "enum") {
    if (!def.enumValues || !def.enumValues.includes(value)) {
      return `expected one of: ${def.enumValues?.join(", ") ?? ""}`;
    }
    return null;
  }
  // string — accept anything non-empty by default
  if (def.type === "string") {
    return null;
  }
  return null;
}

/**
 * Apply persisted overrides into process.env. Called once at boot from
 * instrumentation-node BEFORE any module reads env. Idempotent — safe to
 * call multiple times (subsequent calls overwrite earlier values when
 * the file changes on disk).
 *
 * Skips keys that already have a non-empty value in process.env: the
 * env Jarela was launched with always wins over the persisted overrides.
 * That keeps explicit `JARELA_PORT=… npm start` behavior predictable
 * regardless of what's in the overrides file.
 */
export function applyOverridesToProcessEnv(): { applied: number; skipped: number } {
  const file = readOverridesSync();
  let applied = 0;
  let skipped = 0;
  for (const [k, v] of Object.entries(file.entries)) {
    const existing = process.env[k];
    if (existing && existing.trim() !== "") {
      skipped++;
      continue;
    }
    process.env[k] = v;
    applied++;
  }
  return { applied, skipped };
}

/**
 * Set or unset a single override and persist the result. value === null
 * unsets. Returns the resulting overrides snapshot.
 */
export async function patchOverride(
  name: string,
  value: string | null,
): Promise<OverridesFile> {
  const known = envSchemaByName();
  if (!known.has(name)) throw new Error(`unknown env var: ${name}`);
  const current = await readOverrides();
  const next: Record<string, string> = { ...current.entries };
  if (value === null) {
    delete next[name];
  } else {
    next[name] = value;
  }
  const out: OverridesFile = { version: 1, entries: next };
  await writeOverrides(out);
  return out;
}
