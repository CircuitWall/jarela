/**
 * Operator-initiated install of a vanilla LangChain tool package.
 *
 * Trust model:
 *
 *   - Trusted publishers (see `package-trust.ts`) install immediately.
 *   - Anything else creates a *pending approval* under
 *     `$JARELA_PACKAGES_DIR/pending/<id>.json`. The operator must call
 *     `approvePackageInstall(id)` before the install runs. Until then
 *     the spec is never passed to `npm install`.
 *
 * On install Jarela:
 *
 *   1. Ensures `$JARELA_PACKAGES_DIR/package.json` exists (creates one
 *      with `{ "private": true }` on first call).
 *   2. Runs `npm install --no-fund --no-audit --save <spec>@<version?>`
 *      with cwd = packages dir. Inherits the operator's npm env, so the
 *      registry config / auth tokens from `~/.npmrc` are used as-is.
 *   3. Walks the installed package for `StructuredTool` subclasses (see
 *      `introspectPackage`) and returns the list to the caller. No
 *      manifest is written — that's a separate UI step.
 *
 * Deliberately NOT in this module:
 *   - Manifest CRUD (next PR).
 *   - Credentials bridge (next PR).
 *   - Sandboxing — installed code still runs with full Node trust the
 *     moment it's first imported.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { getPackagesDir } from "./langchain-packages";
import { isPackageAllowed, type PackageAllowDecision } from "./package-allowlist";

export interface IntrospectedTool {
  export: string;
  name: string;
  description: string;
  requiredEnv: string[];
}

export interface PackageInstallResult {
  spec: string;
  publisher: string;
  resolvedPackage: string;
  installedVersion: string | null;
  tools: IntrospectedTool[];
}

export interface PendingInstall {
  id: string;
  spec: string;
  version: string | null;
  publisher: string;
  reason: string;
  createdAt: string;
}

export type InstallOutcome =
  | { status: "installed"; result: PackageInstallResult }
  | { status: "pending"; pending: PendingInstall; allowDecision: PackageAllowDecision };

function pendingDir(): string {
  return join(getPackagesDir(), "pending");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function ensurePackagesPackageJson(packagesDir: string): void {
  ensureDir(packagesDir);
  const pkgPath = join(packagesDir, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(
      pkgPath,
      JSON.stringify(
        {
          name: "jarela-installed-packages",
          private: true,
          description: "Auto-managed by Jarela for hot-loaded LangChain tool packages.",
        },
        null,
        2,
      ),
    );
  }
}

/**
 * Begin an install. Allowed specs install immediately and return the
 * introspected tool list. Disallowed specs return a pending approval
 * the operator must explicitly confirm.
 */
export async function beginInstall(input: {
  spec: string;
  version?: string;
}): Promise<InstallOutcome> {
  const spec = input.spec.trim();
  if (!spec) throw new Error("spec is required");

  const decision = isPackageAllowed(spec);
  if (!decision.allowed) {
    const pending = writePending(spec, input.version ?? null, decision);
    return { status: "pending", pending, allowDecision: decision };
  }

  const result = await runInstall(spec, input.version ?? null);
  return { status: "installed", result };
}

/** Approve a previously-pending install. Throws if `id` is unknown. */
export async function approvePackageInstall(id: string): Promise<PackageInstallResult> {
  const pending = readPending(id);
  if (!pending) throw new Error(`unknown approval id: ${id}`);
  const result = await runInstall(pending.spec, pending.version);
  deletePending(id);
  return result;
}

export function listPendingInstalls(): PendingInstall[] {
  const dir = pendingDir();
  if (!existsSync(dir)) return [];
  const rows: PendingInstall[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const p = join(dir, entry);
    try {
      const row = JSON.parse(readFileSync(p, "utf8")) as PendingInstall;
      if (row && typeof row.id === "string") rows.push(row);
    } catch {
      // ignore malformed pending file
    }
  }
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return rows;
}

export function denyPackageInstall(id: string): boolean {
  return deletePending(id);
}

function writePending(spec: string, version: string | null, decision: PackageAllowDecision): PendingInstall {
  ensureDir(pendingDir());
  const pending: PendingInstall = {
    id: randomUUID(),
    spec,
    version,
    publisher: decision.publisher,
    reason: `Publisher "${decision.publisher}" is not in the package allowlist. Approve to install.`,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(pendingDir(), `${pending.id}.json`), JSON.stringify(pending, null, 2));
  return pending;
}

function readPending(id: string): PendingInstall | null {
  const p = join(pendingDir(), `${id}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as PendingInstall;
  } catch {
    return null;
  }
}

function deletePending(id: string): boolean {
  const p = join(pendingDir(), `${id}.json`);
  if (!existsSync(p)) return false;
  try {
    rmSync(p, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function runInstall(spec: string, version: string | null): Promise<PackageInstallResult> {
  const packagesDir = getPackagesDir();
  ensurePackagesPackageJson(packagesDir);

  const npmSpec = version ? `${spec}@${version}` : spec;
  await runNpm(["install", "--no-fund", "--no-audit", "--save", npmSpec], packagesDir);

  // The npm spec may include a version range. The *package name* we
  // resolve and import is the spec minus the version portion.
  const resolvedPackage = stripVersion(spec);
  const installedVersion = readInstalledVersion(packagesDir, resolvedPackage);
  const tools = await introspectPackage(packagesDir, resolvedPackage);
  const decision = isPackageAllowed(spec);

  return {
    spec,
    publisher: decision.publisher,
    resolvedPackage,
    installedVersion,
    tools,
  };
}

function stripVersion(spec: string): string {
  if (spec.startsWith("@")) {
    const at = spec.indexOf("@", 1);
    return at === -1 ? spec : spec.slice(0, at);
  }
  const at = spec.indexOf("@");
  return at === -1 ? spec : spec.slice(0, at);
}

function readInstalledVersion(packagesDir: string, pkg: string): string | null {
  const pkgJson = join(packagesDir, "node_modules", pkg, "package.json");
  if (!existsSync(pkgJson)) return null;
  try {
    const j = JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: string };
    return typeof j.version === "string" ? j.version : null;
  } catch {
    return null;
  }
}

function runNpm(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(npmCmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stderr = "";
    child.stderr?.on("data", (b) => { stderr += b.toString(); });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ${args.join(" ")} exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

/**
 * Walk a freshly installed package and return every export that, when
 * constructed with no args, produces an object matching the LangChain
 * StructuredTool duck-type. Errors per export are swallowed — a single
 * bad export must not poison the introspection of the others.
 */
export async function introspectPackage(
  packagesDir: string,
  pkg: string,
): Promise<IntrospectedTool[]> {
  const pkgDir = join(packagesDir, "node_modules", pkg);
  if (!existsSync(pkgDir)) return [];

  const entries: string[] = [pkg];
  const pkgJsonPath = join(pkgDir, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const json = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
        exports?: unknown;
      };
      if (json.exports && typeof json.exports === "object") {
        for (const key of Object.keys(json.exports as Record<string, unknown>)) {
          if (key === "." || key === "./package.json") continue;
          if (!key.startsWith("./")) continue;
          entries.push(`${pkg}${key.slice(1)}`);
        }
      }
    } catch {
      // ignore — fall back to root entry only
    }
  }

  const { createRequire } = (
    process as unknown as { getBuiltinModule: (id: string) => typeof import("node:module") }
  ).getBuiltinModule("node:module");
  const req = createRequire(join(packagesDir, "_anchor"));

  const seen = new Set<string>();
  const out: IntrospectedTool[] = [];

  for (const entry of entries) {
    let resolved: string;
    try {
      resolved = req.resolve(entry);
    } catch {
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
    } catch {
      continue;
    }

    for (const [exportName, value] of Object.entries(mod)) {
      if (typeof value !== "function") continue;
      let instance: unknown;
      try {
        instance = new (value as new (...args: unknown[]) => unknown)();
      } catch {
        continue;
      }
      if (!isStructuredToolLike(instance)) continue;
      const tool = instance as { name: string; description: string };
      out.push({
        export: exportName,
        name: tool.name,
        description: tool.description.slice(0, 500),
        requiredEnv: detectEnvVars(value as object),
      });
    }
  }

  // Stable, dedup-on-name ordering for the UI.
  const byName = new Map<string, IntrospectedTool>();
  for (const t of out) if (!byName.has(t.name)) byName.set(t.name, t);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function isStructuredToolLike(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    o.name.length > 0 &&
    typeof o.description === "string" &&
    "schema" in o &&
    typeof (o as { invoke?: unknown }).invoke === "function"
  );
}

/**
 * Best-effort: scan a class's source for `process.env.SOMETHING`
 * references so the UI can surface "Tavily wants TAVILY_API_KEY" without
 * an out-of-band package adapter. Returns at most 8 candidates.
 */
function detectEnvVars(ctor: object): string[] {
  let src: string;
  try {
    src = ctor.toString();
  } catch {
    return [];
  }
  const found = new Set<string>();
  const re = /process\.env\.([A-Z][A-Z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[1]) found.add(m[1]);
    if (found.size >= 8) break;
  }
  return [...found];
}

/** @internal — test-only: wipe pending dir. */
export function _resetPackageInstallStore(): void {
  const dir = pendingDir();
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      try { rmSync(join(dir, entry), { force: true }); } catch { /* ignore */ }
    }
  }
}

/** @internal — exported for unit tests that need to assert dir contents. */
export function _pendingDirForTest(): string {
  return pendingDir();
}
