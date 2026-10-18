import { join } from "node:path";
import { getPackagesDir } from "./langchain-packages";

const missing = Symbol("optional-package-missing");
const testOverrides = new Map<string, AnyModule>();

type AnyModule = Record<string, unknown>;

type OptionalRequire = NodeJS.Require;

function createRuntimeRequire(anchor: string): OptionalRequire {
  const getBuiltinModule = (process as unknown as {
    getBuiltinModule?: (id: string) => typeof import("node:module") | undefined;
  }).getBuiltinModule;
  if (!getBuiltinModule) throw new Error("Node runtime does not expose getBuiltinModule");
  const moduleBuiltin = getBuiltinModule("node:module");
  if (!moduleBuiltin) throw new Error("Node runtime cannot load node:module");
  return moduleBuiltin.createRequire(anchor);
}

function managedPackagePath(packageName: string): string {
  return join(getPackagesDir(), "node_modules", packageName);
}

interface ResolvedOptionalPackage {
  req: OptionalRequire;
  path: string;
}

function resolveOptionalPackage(packageName: string): ResolvedOptionalPackage | null {
  const managedReq = createRuntimeRequire(join(getPackagesDir(), "_anchor"));
  try {
    return {
      req: managedReq,
      path: managedReq.resolve(managedPackagePath(packageName)),
    };
  } catch {
    // Workspace builds expose bundled @circuitwall packages from the app root.
  }

  if (process.env.JARELA_PACKAGES_DIR?.trim()) return null;
  if (!packageName.startsWith("@circuitwall/")) return null;

  const appReq = createRuntimeRequire(join(process.cwd(), "package.json"));
  try {
    return { req: appReq, path: appReq.resolve(packageName) };
  } catch {
    return null;
  }
}

export function loadOptionalPackage<T extends AnyModule>(packageName: string): T | null {
  const override = testOverrides.get(packageName);
  if (override) return override as T;
  const resolved = resolveOptionalPackage(packageName);
  if (!resolved) return null;
  try {
    return resolved.req(resolved.path) as T;
  } catch (err) {
    // Keep the optional boundary non-fatal, but leave the actual load failure
    // visible so missing peer dependencies are diagnosable from server logs.
    console.error(`[optional-package] failed to load ${packageName}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

/**
 * Resolve an export at call time so an npm install followed by package reload
 * can activate a package that was absent when the server first booted.
 */
export function optionalExport<T>(packageName: string, exportName: string, fallback: T): T {
  const mod = loadOptionalPackage<AnyModule>(packageName);
  const value = mod?.[exportName];
  return (value === undefined ? fallback : value) as T;
}

export function optionalTools<T>(packageName: string, exportName: string): readonly T[] {
  return new Proxy([] as T[], {
    get(_target, property) {
      const values = optionalExport<readonly T[]>(packageName, exportName, []);
      const value = Reflect.get(values, property, values);
      return typeof value === "function" ? value.bind(values) : value;
    },
  });
}

export function optionalFunction<T extends (...args: any[]) => any>(
  packageName: string,
  exportName: string,
  fallback: T,
): T {
  return ((...args: Parameters<T>) => {
    const fn = optionalExport<T | typeof missing>(packageName, exportName, missing);
    return fn === missing ? fallback(...args) : fn(...args);
  }) as T;
}

export function isOptionalPackageInstalled(packageName: string): boolean {
  const resolved = resolveOptionalPackage(packageName);
  if (!resolved) return false;
  try {
    resolved.req(resolved.path);
    return true;
  } catch (err) {
    console.error(`[optional-package] failed to load ${packageName}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** @internal — test-only seam for modules loaded through createRequire. */
export function _setOptionalPackageForTests(packageName: string, module: AnyModule): void {
  testOverrides.set(packageName, module);
}

/** @internal — test-only. */
export function _clearOptionalPackageTestOverrides(): void {
  testOverrides.clear();
}
