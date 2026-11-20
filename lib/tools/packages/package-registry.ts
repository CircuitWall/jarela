/**
 * Registry-side helpers for operator-initiated installs.
 *
 * Three problems this solves, all seen in the wild:
 *
 *   1. A typo (`@huggingface/transformer`) became a pending approval, and
 *      approving it returned npm's raw 404 as an HTTP 500.
 *   2. The user had no way to know the right name — even though Jarela now
 *      ships a catalogue that contains it.
 *   3. The dead pending record stayed in the queue.
 *
 * `probePackageExists` is deliberately best-effort: an offline or restricted
 * network must not block installs, so anything other than a definitive 404 is
 * reported as `unknown` and the install proceeds.
 */
import { OPTIONAL_PACKAGES } from "@/lib/dependencies/optional-catalog";
import { LANGCHAIN_CATALOG } from "./langchain-catalog";
import { packageRootOf } from "@/lib/dependencies/schema";

export type InstallFailureCode = "not_found" | "forbidden" | "peer_conflict" | "network" | "unknown";

const PROBE_TIMEOUT_MS = 4_000;

export function classifyInstallFailure(message: string): InstallFailureCode {
  if (/\bE404\b|404 Not Found|could not be found|is not in this registry/i.test(message)) return "not_found";
  if (/\bE40[13]\b|\b403\b|\b401\b|unauthorized|forbidden/i.test(message)) return "forbidden";
  if (/ERESOLVE|peer dep|peer-dependenc/i.test(message)) return "peer_conflict";
  if (/EAI_AGAIN|ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|network|fetch failed|socket hang up/i.test(message)) {
    return "network";
  }
  return "unknown";
}

/** Candidate package names we can suggest from — no network, no npm. */
export function knownPackageNames(): string[] {
  const names = new Set<string>();
  for (const entry of OPTIONAL_PACKAGES) names.add(entry.id);
  for (const entry of LANGCHAIN_CATALOG) names.add(packageRootOf(entry.npmPackage));
  return [...names];
}

/** Levenshtein distance with an early exit once `max + 1` is exceeded. */
function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * Closest known package name for an unknown spec, or null. Accepts one
 * insertion/deletion/substitution or a case difference, which covers the
 * typo class that actually reaches the registry.
 */
export function suggestPackageName(spec: string, candidates: readonly string[] = knownPackageNames()): string | null {
  const requested = packageRootOf(spec).toLowerCase();
  if (requested === "") return null;
  let best: { name: string; distance: number } | null = null;
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    if (normalized === requested) continue;
    const distance = editDistance(requested, normalized, 2);
    if (distance > 2) continue;
    if (!best || distance < best.distance) best = { name: candidate, distance };
    if (distance === 1) break;
  }
  return best?.name ?? null;
}

export type RegistryProbeResult = "exists" | "missing" | "unknown";

type RegistryProbe = (spec: string) => Promise<RegistryProbeResult>;

async function probeViaRegistry(spec: string): Promise<RegistryProbeResult> {
  if (process.env.JARELA_DISABLE_REGISTRY_PROBE === "1") return "unknown";
  // Unit tests must stay hermetic; they use `_setRegistryProbeForTests`.
  if (process.env.NODE_ENV === "test" && process.env.JARELA_ENABLE_REGISTRY_PROBE !== "1") return "unknown";
  const name = packageRootOf(spec);
  if (name === "") return "missing";
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      method: "GET",
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status === 404) return "missing";
    if (res.ok) return "exists";
    return "unknown";
  } catch {
    // Offline, proxy-less, or registry unreachable: never block an install.
    return "unknown";
  }
}

let probe: RegistryProbe = probeViaRegistry;

/** Best-effort "does this package exist on the configured registry?". */
export function probePackageExists(spec: string): Promise<RegistryProbeResult> {
  return probe(spec);
}

/** @internal — test seam. */
export function _setRegistryProbeForTests(fn: RegistryProbe | null): void {
  probe = fn ?? probeViaRegistry;
}
