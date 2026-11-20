/**
 * Dependency probes — "is this capability's dependency installed?".
 *
 * Mirrors the readiness model in `lib/health/probe-cache.ts`:
 *
 *   - caching has a TTL (60 s here) and is invalidated after an install;
 *   - refreshes are single-flight per dependency;
 *   - a probe that cannot decide reports `unverified`, which never hides a
 *     tool, so a transient filesystem/spawn error cannot make an agent's
 *     toolset disappear mid-conversation;
 *   - the synchronous accessor used by the tool catalog schedules a
 *     background refresh instead of blocking.
 *
 * Probes never install, never spawn a shell, and never run a binary. The one
 * process fact they read is `process.version` for `node-runtime`.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { isOptionalPackageInstalled } from "@/lib/tools/packages/optional-package";
import { findExecutable, resetExecutableCache } from "./executable";
import {
  dependencyKey,
  isRequired,
  type DependencyReadiness,
  type DependencySpec,
  type DependencyState,
  type DependencyStatus,
  type NodePackageScope,
} from "./schema";
import { parseRange, satisfiesRange } from "./semver";

const TTL_MS = 60_000;

interface CacheEntry {
  status: DependencyStatus;
  checkedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Set<string>();

function backgroundRefreshEnabled(): boolean {
  return process.env.NODE_ENV !== "test" || process.env.JARELA_ENABLE_DEPENDENCY_PROBE === "1";
}

/** Candidate npm global `node_modules` roots, most specific first. */
function globalNodeModuleRoots(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  const exeDir = dirname(process.execPath);
  // Version-managed installs (nvm, volta, asdf, n) keep global modules next
  // to the running node binary.
  roots.push(join(exeDir, "node_modules"));
  roots.push(join(exeDir, "..", "lib", "node_modules"));
  if (process.platform === "win32") {
    if (env.APPDATA) roots.push(join(env.APPDATA, "npm", "node_modules"));
    if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, "npm", "node_modules"));
  } else {
    roots.push("/usr/local/lib/node_modules", "/usr/lib/node_modules");
    if (env.HOME) roots.push(join(env.HOME, ".npm-global", "lib", "node_modules"));
  }
  return [...new Set(roots)];
}

function status(
  spec: DependencySpec,
  state: DependencyState,
  detail: string | null,
  installable: boolean,
): DependencyStatus {
  return {
    kind: spec.kind,
    id: spec.id,
    scope: spec.kind === "node-package" ? (spec.scope ?? "managed") : null,
    state,
    installable,
    detail,
    required: isRequired(spec),
    hint: spec.hint ?? null,
    docs_url: spec.docs_url ?? null,
    checked_at: new Date().toISOString(),
  };
}

function probeNodePackage(spec: DependencySpec, env: NodeJS.ProcessEnv, platform?: NodeJS.Platform): DependencyStatus {
  const scope: NodePackageScope = spec.scope ?? "managed";

  if (scope === "global") {
    if (spec.bin) {
      const onPath = findExecutable(spec.bin, { env, platform });
      if (onPath) return status(spec, "satisfied", "on-path", true);
    }
    const root = globalNodeModuleRoots(env).find((dir) => existsSync(join(dir, spec.id, "package.json")));
    if (root) return status(spec, "satisfied", "npm-global", true);
    return status(spec, "missing", spec.bin ? "not-on-path" : "not-in-global", true);
  }

  const resolved = isOptionalPackageInstalled(spec.id);
  return resolved
    ? status(spec, "satisfied", scope === "workspace" ? "workspace" : "managed-packages", true)
    : status(spec, "missing", "unresolved", true);
}

function probeExecutable(spec: DependencySpec, env: NodeJS.ProcessEnv, platform?: NodeJS.Platform): DependencyStatus {
  const found = findExecutable(spec.id, { env, platform });
  return found
    ? status(spec, "satisfied", "on-path", false)
    : status(spec, "missing", "not-on-path", false);
}

function probeNodeRuntime(spec: DependencySpec): DependencyStatus {
  const range = spec.version ?? "";
  if (!parseRange(range)) return status(spec, "unverified", "invalid-range", false);
  return satisfiesRange(process.version, range)
    ? status(spec, "satisfied", `detected ${process.version}`, false)
    : status(spec, "missing", `requires ${range}`, false);
}

export interface ProbeOptions {
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Pin PATH rules to a platform (tests, and future cross-platform audits). */
  platform?: NodeJS.Platform;
}

/** Run one probe, bypassing the cache only when `force` is set. */
export async function probeDependency(
  spec: DependencySpec,
  options: ProbeOptions = {},
): Promise<DependencyStatus> {
  const key = dependencyKey(spec);
  if (!options.force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.checkedAt <= TTL_MS) return hit.status;
  }

  const env = options.env ?? process.env;
  let result: DependencyStatus;
  try {
    switch (spec.kind) {
      case "node-package": result = probeNodePackage(spec, env, options.platform); break;
      case "executable": result = probeExecutable(spec, env, options.platform); break;
      case "node-runtime": result = probeNodeRuntime(spec); break;
    }
  } catch (err) {
    result = status(spec, "unverified", err instanceof Error ? err.message : String(err), false);
  }

  cache.set(key, { status: result, checkedAt: Date.now() });
  return result;
}

/** Probe several dependencies, deduped by key, in parallel. */
export async function probeDependencies(
  specs: readonly DependencySpec[],
  options: ProbeOptions = {},
): Promise<DependencyStatus[]> {
  const seen = new Map<string, Promise<DependencyStatus>>();
  for (const spec of specs) {
    const key = dependencyKey(spec);
    if (!seen.has(key)) seen.set(key, probeDependency(spec, options));
  }
  return Promise.all(specs.map((spec) => seen.get(dependencyKey(spec))!));
}

function scheduleRefresh(spec: DependencySpec): void {
  const key = dependencyKey(spec);
  if (!backgroundRefreshEnabled() || inFlight.has(key)) return;
  inFlight.add(key);
  void (async () => {
    try {
      await probeDependency(spec, { force: true });
    } catch {
      // probeDependency already folds failures into `unverified`.
    } finally {
      inFlight.delete(key);
    }
  })();
}

/**
 * Synchronous read used by the tool catalog. Never blocks: an unknown or
 * expired entry returns `unverified` and refreshes in the background.
 */
export function getCachedDependencyStatus(spec: DependencySpec): DependencyStatus {
  const hit = cache.get(dependencyKey(spec));
  if (!hit) {
    scheduleRefresh(spec);
    return status(spec, "unverified", "not-probed", spec.kind === "node-package");
  }
  if (Date.now() - hit.checkedAt > TTL_MS) scheduleRefresh(spec);
  return hit.status;
}

/** Collapse a set of statuses into one readiness verdict. */
export function summarizeDependencies(statuses: readonly DependencyStatus[]): DependencyReadiness {
  let unverified = false;
  for (const s of statuses) {
    if (!s.required) continue;
    if (s.state === "missing") return "missing";
    if (s.state === "unverified") unverified = true;
  }
  return unverified ? "unverified" : "ready";
}

/** First required dependency that is missing, for user-facing messages. */
export function firstMissingDependency(
  statuses: readonly DependencyStatus[],
): DependencyStatus | null {
  return statuses.find((s) => s.required && s.state === "missing") ?? null;
}

export function missingDependencies(statuses: readonly DependencyStatus[]): DependencyStatus[] {
  return statuses.filter((s) => s.required && s.state === "missing");
}

export function anyMissingDependencyInstallable(statuses: readonly DependencyStatus[]): boolean {
  return missingDependencies(statuses).some((s) => s.installable);
}

/** One-line, user-facing explanation for a blocking dependency. */
export function missingDependencyMessage(status: DependencyStatus): string {
  const label = status.scope === "global" ? `${status.id} (global CLI)` : status.id;
  if (status.hint) return `${label} is missing (${status.state}). ${status.hint}`;
  if (status.installable) {
    return `${label} is missing (${status.state}). Install it from Settings → Tools → Packages to enable this feature.`;
  }
  return `${label} is missing (${status.state}) and must be installed outside Jarela.`;
}

/** Drop cached results after an install/uninstall so the next read re-probes. */
export function invalidateDependencyStatuses(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
  resetExecutableCache();
}

/** @internal — test-only: pin a state without touching the filesystem. */
export function _setDependencyStatusForTests(spec: DependencySpec, state: DependencyState): void {
  const installable = spec.kind === "node-package";
  cache.set(dependencyKey(spec), { status: status(spec, state, "test", installable), checkedAt: Date.now() });
}

/** @internal — test-only. */
export function _resetDependencyCache(): void {
  cache.clear();
  inFlight.clear();
  resetExecutableCache();
}
