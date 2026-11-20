/**
 * On-demand runtime packages.
 *
 * Some capabilities need a large npm runtime that most installs never use:
 * the local embedding stack (`@huggingface/transformers` + ONNX runtimes) and
 * the Copilot agent runtime (`@microsoft/copilot-sdk` + its platform package).
 * Shipping them as regular `dependencies` costs hundreds of megabytes for
 * every install (ADR-0122).
 *
 * They are therefore resolved at call time from `$JARELA_PACKAGES_DIR` (or the
 * app root in a dev checkout) through `createRequire`, so Next never resolves
 * the specifier at build time and a missing package is a normal state rather
 * than a build failure. Installing them is an explicit operator action through
 * `/api/v1/dependencies/install`, gated by the same trust model as every other
 * managed package.
 *
 * This module deliberately imports only leaf modules: it is reached from
 * `lib/embeddings/local.ts`, which sits on the module graph the tool registry
 * initializes, so pulling in the package loader (→ manifest loader → registry)
 * here would re-create a cycle.
 */
import { join } from "node:path";

import { getPackagesDir } from "@/lib/tools/packages/packages-dir";

export class RuntimePackageUnavailableError extends Error {
  readonly packageName: string;

  constructor(packageName: string, capability: string) {
    super(
      `${capability} needs the "${packageName}" package, which is not installed. ` +
      `Install it from Settings → Tools → Packages (or run "npm install --save ${packageName}" in the Jarela packages directory).`,
    );
    this.name = "RuntimePackageUnavailableError";
    this.packageName = packageName;
  }
}

type AnyModule = Record<string, unknown>;

const testOverrides = new Map<string, AnyModule>();

function runtimeRequire(anchor: string): NodeJS.Require {
  const getBuiltinModule = (process as unknown as {
    getBuiltinModule?: (id: string) => typeof import("node:module") | undefined;
  }).getBuiltinModule;
  if (!getBuiltinModule) throw new Error("Node runtime does not expose getBuiltinModule");
  const moduleBuiltin = getBuiltinModule("node:module");
  if (!moduleBuiltin) throw new Error("Node runtime cannot load node:module");
  return moduleBuiltin.createRequire(anchor);
}

/** Load a runtime package from the packages dir (or the app root), or null. */
export function loadRuntimePackage<T extends AnyModule>(packageName: string): T | null {
  const override = testOverrides.get(packageName);
  if (override) return override as T;

  try {
    const managed = runtimeRequire(join(getPackagesDir(), "_anchor"));
    return managed(managed.resolve(join(getPackagesDir(), "node_modules", packageName))) as T;
  } catch {
    // Fall through to the app root (dev checkouts, and the first run after an
    // upgrade before the on-demand install happens).
  }

  // An operator-set packages dir is authoritative: never silently fall back to
  // a developer checkout.
  if (process.env.JARELA_PACKAGES_DIR?.trim()) return null;

  try {
    const app = runtimeRequire(join(process.cwd(), "package.json"));
    return app(app.resolve(packageName)) as T;
  } catch {
    // Not installed anywhere — the caller decides whether that blocks.
    return null;
  }
}

/** Load a runtime package or throw a message that names the fix. */
export function requireRuntimePackage<T extends AnyModule>(
  packageName: string,
  capability: string,
): T {
  const loaded = loadRuntimePackage<T>(packageName);
  if (!loaded) throw new RuntimePackageUnavailableError(packageName, capability);
  return loaded;
}

export function isRuntimePackageInstalled(packageName: string): boolean {
  return loadRuntimePackage(packageName) !== null;
}

/** @internal — test-only seam for modules loaded through createRequire. */
export function _setRuntimePackageForTests(packageName: string, module: AnyModule): void {
  testOverrides.set(packageName, module);
}

/** @internal — test-only. */
export function _clearRuntimePackageTestOverrides(): void {
  testOverrides.clear();
}
