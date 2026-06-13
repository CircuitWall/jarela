/**
 * Generic loader for LangChain tool packages.
 *
 * Use this to register any package that ships a bundle of
 * `StructuredToolInterface` instances grouped by capability. It handles
 * three responsibilities the in-tree adapters used to repeat by hand:
 *
 *   1. Capability registration — calls `registerTools(category, capability,
 *      bucket)` for each non-empty `tools.read | write | execute` bucket.
 *   2. Optional credential bridge — for packages that expose a
 *      `setAuthResolver()` hook (the Circuit Wall convention), the loader
 *      builds an env-first / DB-fallback resolver that reads from Jarela's
 *      encrypted integrations store and hands it to the package.
 *   3. A `resolveAuth` callback the caller can re-export as the
 *      `_resolveXxxAuth` probe used by the integrations test endpoint.
 *
 * Vanilla LangChain tool packages (no `setAuthResolver` hook) simply omit
 * the `auth` field — the loader becomes a thin facade over
 * `registerTools`. This is the building block for the hot-load path:
 * any spec object (whether hand-written here or produced by an external
 * loader) is wired into the registry the same way.
 */
import type { StructuredToolInterface } from "@langchain/core/tools";
import { getIntegrationRaw } from "@/lib/stores/integrations";
import { registerTools, unregisterTools, type BuiltinCategory } from "./registry";

/**
 * Bridge between a package's `setAuthResolver()` hook and Jarela's
 * encrypted integrations store + env vars.
 *
 * Resolution order, matching the previous hand-written adapters:
 *   1. `resolveAuthFromEnv()` — process env vars win (deployment config).
 *   2. `getIntegrationRaw(integrationId)` → `mapStoreFields(raw)` — saved
 *      credentials from the Integrations panel.
 *   3. `{ error: notConfiguredError }` — nothing is set.
 */
export interface AuthBridge<TAuth> {
  /** Matches an INTEGRATIONS key in lib/stores/integrations.ts. */
  integrationId: string;
  /** Package's `setAuthResolver()` export. */
  setAuthResolver: (fn: () => TAuth | { error: string }) => void;
  /** Package's `resolveXxxAuthFromEnv()` export. */
  resolveAuthFromEnv: () => TAuth | { error: string };
  /**
   * Convert the integrations-store row (raw field values, all strings) to
   * the package's auth shape. Return `null` if the required fields are
   * missing so the loader can fall through to the not-configured error.
   */
  mapStoreFields: (raw: Record<string, string>) => TAuth | null;
  /** User-facing message shown when env + DB are both empty. */
  notConfiguredError: string;
}

export interface LangChainPackageSpec<TAuth = unknown> {
  /** Category bucket shown in the Agent editor sidebar. */
  category: BuiltinCategory;
  /** Capability buckets. Any combination may be omitted or empty. */
  tools: {
    read?: readonly StructuredToolInterface[];
    write?: readonly StructuredToolInterface[];
    execute?: readonly StructuredToolInterface[];
  };
  /** Optional credential bridge for packages with `setAuthResolver()`. */
  auth?: AuthBridge<TAuth>;
}

export interface RegisteredPackage<TAuth> {
  /**
   * Resolves credentials the same way the package will at call time. Used
   * by the integrations test endpoint to probe live API connectivity right
   * after the user saves credentials.
   */
  resolveAuth: () => TAuth | { error: string };
  /**
   * Removes every tool this package added from the registry. Used by the
   * hot-load path when an operator changes or removes a package without
   * restarting the server. In-tree side-effect-imported tools never call
   * this — once registered they live for the process lifetime.
   *
   * Note: the package's own `setAuthResolver` slot is NOT cleared. The
   * package is expected to be unreachable (no tool surface) after
   * unregister, so nothing should be calling its resolver.
   */
  unregister: () => void;
}

export function registerLangChainPackage<TAuth>(
  spec: LangChainPackageSpec<TAuth>,
): RegisteredPackage<TAuth> {
  const registered: string[] = [];
  if (spec.tools.read && spec.tools.read.length > 0) {
    for (const t of registerTools(spec.category, "read", spec.tools.read)) registered.push(t.name);
  }
  if (spec.tools.write && spec.tools.write.length > 0) {
    for (const t of registerTools(spec.category, "write", spec.tools.write)) registered.push(t.name);
  }
  if (spec.tools.execute && spec.tools.execute.length > 0) {
    for (const t of registerTools(spec.category, "execute", spec.tools.execute)) registered.push(t.name);
  }

  const unregister = (): void => {
    unregisterTools(registered);
  };

  if (!spec.auth) {
    // No credential bridge — the package either needs no auth or reads
    // its own env vars at call time. Surface a stub resolver for type
    // symmetry; callers without an auth bridge should not be wiring this
    // through to the integrations test endpoint.
    const noop = (): TAuth | { error: string } => ({
      error: `package "${spec.category}" has no auth bridge configured`,
    });
    return { resolveAuth: noop, unregister };
  }

  const { integrationId, setAuthResolver, resolveAuthFromEnv, mapStoreFields, notConfiguredError } = spec.auth;

  const resolveAuth = (): TAuth | { error: string } => {
    // Env first — deployment-level config wins over per-user secrets in DB.
    const fromEnv = resolveAuthFromEnv();
    if (!isErr(fromEnv)) return fromEnv;
    const saved = getIntegrationRaw(integrationId);
    if (saved) {
      const mapped = mapStoreFields(saved);
      if (mapped !== null) return mapped;
    }
    return { error: notConfiguredError };
  };

  setAuthResolver(resolveAuth);
  return { resolveAuth, unregister };
}

function isErr<T>(v: T | { error: string }): v is { error: string } {
  return typeof v === "object" && v !== null && "error" in v;
}
