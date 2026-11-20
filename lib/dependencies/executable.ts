/**
 * PATH lookup for `executable` / global-CLI dependencies.
 *
 * Deterministic, cache-backed and side-effect free: it never spawns a shell
 * and never runs the binary — it only answers "would `spawn(name)` find it?".
 * That keeps the probe cheap enough to run from the tool catalog and avoids
 * the ENOENT/EINVAL traps that come with `which`/`.cmd` shims on Windows.
 */
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const TTL_MS = 30_000;

interface CacheEntry {
  /** Resolved absolute path, or null when the lookup failed. */
  path: string | null;
  checkedAt: number;
}

const cache = new Map<string, CacheEntry>();

export interface ExecutableLookupOptions {
  /** Defaults to `process.env`. Tests pass a synthetic PATH. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `process.platform`. Tests pin it to drive both branches. */
  platform?: NodeJS.Platform;
  /** Ignore the cache (used after an install). */
  force?: boolean;
}

function extensionsFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== "win32") return [""];
  const raw = env.PATHEXT?.trim() || DEFAULT_PATHEXT;
  return ["", ...raw.split(";").map((e) => e.trim()).filter(Boolean)];
}

// PATH splitting follows the *target* platform so both branches are testable
// from one host. File paths use the host separator because they touch the
// local filesystem, which always matches the target platform in production.
function pathDelimiterFor(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function joinFor(dir: string, file: string, platform: NodeJS.Platform): string {
  void platform;
  return join(dir, file);
}

function isAbsoluteFor(file: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    return /^[A-Za-z]:[\\/]/.test(file) || file.startsWith("\\\\");
  }
  return file.startsWith("/");
}

function isExecutableFile(file: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  try {
    if (!statSync(file).isFile()) return false;
  } catch {
    return false;
  }
  if (platform === "win32") {
    const ext = /(\.[^.\\/]+)$/.exec(file)?.[1]?.toUpperCase();
    if (!ext) return false;
    const allowed = extensionsFor("win32", env)
      .map((e) => e.toUpperCase())
      .filter((e) => e !== "");
    return allowed.includes(ext);
  }
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function lookup(
  name: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | null {
  const exts = extensionsFor(platform, env);

  // A path-like name is checked directly; PATH is not consulted.
  if (isAbsoluteFor(name, platform) || name.includes("/") || name.includes("\\")) {
    for (const ext of exts) {
      const candidate = `${name}${ext}`;
      if (isExecutableFile(candidate, platform, env)) return candidate;
    }
    return null;
  }

  const pathVar = env.PATH ?? env.Path ?? "";
  if (pathVar.trim() === "") return null;
  for (const dir of pathVar.split(pathDelimiterFor(platform))) {
    if (dir.trim() === "") continue;
    for (const ext of exts) {
      const candidate = joinFor(dir, `${name}${ext}`, platform);
      if (isExecutableFile(candidate, platform, env)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve an executable name against PATH. Returns the absolute path, or
 * null when it is not present. Results are cached for 30 s per
 * (platform, name, PATH) so a catalog build stays cheap.
 */
export function findExecutable(
  name: string,
  options: ExecutableLookupOptions = {},
): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return null;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const key = `${platform}|${trimmed}|${env.PATH ?? env.Path ?? ""}|${env.PATHEXT ?? ""}`;

  if (!options.force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.checkedAt <= TTL_MS) return hit.path;
  }

  const path = lookup(trimmed, platform, env);
  cache.set(key, { path, checkedAt: Date.now() });
  return path;
}

export function isExecutableOnPath(
  name: string,
  options: ExecutableLookupOptions = {},
): boolean {
  return findExecutable(name, options) !== null;
}

/** @internal — drop cached lookups (after an install, or between tests). */
export function resetExecutableCache(): void {
  cache.clear();
}
