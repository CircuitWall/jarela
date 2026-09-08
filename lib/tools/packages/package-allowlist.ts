/**
 * Publisher allowlist for `POST /api/v1/packages/install`.
 *
 * Follows the same naming pattern as `lib/env/allowlist.ts` —
 * `PACKAGE_PUBLISHER_ALLOWLIST` is the static, code-owned default; the
 * `JARELA_PACKAGE_ALLOWLIST` env var extends it with operator-supplied
 * prefixes; `getEffectivePackageAllowlist()` returns the merged list.
 *
 * Default-allowed publishers cover the LangChain ecosystem
 * (`@langchain/*`, bare `langchain`) and Jarela's own (`@circuitwall/*`).
 * Anything not matched returns a pending approval that the operator
 * must explicitly OK before Jarela shells out to npm — keeping the
 * install endpoint from being a foot-gun for arbitrary code execution
 * while still letting trusted ecosystems install in one click.
 */

export const PACKAGE_PUBLISHER_ALLOWLIST: readonly string[] = [
  "@langchain/",
  "@circuitwall/",
  "langchain",            // matches bare "langchain" and "langchain/..." subpaths
] as const;

export interface PackageAllowDecision {
  allowed: boolean;
  matchedPrefix: string | null;
  publisher: string;       // "@scope" or "<unscoped-name>"
}

function parseEnvPrefixes(): string[] {
  const raw = process.env.JARELA_PACKAGE_ALLOWLIST;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Static defaults merged with `JARELA_PACKAGE_ALLOWLIST` env overrides.
 * Same merge order as `getEffectiveAllowlist` in `lib/env/allowlist.ts`
 * (defaults first, env additions after).
 */
export function getEffectivePackageAllowlist(): string[] {
  return [...PACKAGE_PUBLISHER_ALLOWLIST, ...parseEnvPrefixes()];
}

/**
 * Extract the publisher token from an npm spec. Returns the scope
 * (`@langchain`) for scoped packages, or the unscoped package name.
 * Strips subpaths and version ranges.
 */
export function publisherOf(spec: string): string {
  const noVersion = spec.split("@").slice(0, spec.startsWith("@") ? 2 : 1).join("@");
  if (noVersion.startsWith("@")) {
    return noVersion.split("/")[0] ?? noVersion;
  }
  return noVersion.split("/")[0] ?? noVersion;
}

export function isPackageAllowed(spec: string): PackageAllowDecision {
  const publisher = publisherOf(spec);
  for (const prefix of getEffectivePackageAllowlist()) {
    // Prefix matches either the exact package name or the scope (with
    // trailing slash). Comparison is case-sensitive — npm names are too.
    if (spec === prefix) return { allowed: true, matchedPrefix: prefix, publisher };
    if (spec.startsWith(prefix)) return { allowed: true, matchedPrefix: prefix, publisher };
    if (publisher === prefix.replace(/\/$/, "")) {
      return { allowed: true, matchedPrefix: prefix, publisher };
    }
  }
  return { allowed: false, matchedPrefix: null, publisher };
}
