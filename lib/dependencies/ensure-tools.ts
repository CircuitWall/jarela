/**
 * Ensure the dependencies of enabled tools.
 *
 * Kept apart from `ensure.ts` so the generic installer never imports the tool
 * catalogue (the catalogue sits on the registry module graph).
 */
import { getToolDependencySpecs } from "@/lib/tools/runtime/catalog";
import { ensureTargets, type EnsureOptions, type EnsureOutcome } from "./ensure";

/** Dependency-bearing tool names among `names`, in input order. */
export function toolsWithDependencies(names: readonly string[]): string[] {
  return names.filter((name) => getToolDependencySpecs(name).length > 0);
}

/** Install what the given tools need. Safe to fire-and-forget. */
export async function ensureTools(
  names: readonly string[],
  options: EnsureOptions = {},
): Promise<EnsureOutcome[]> {
  const targets = toolsWithDependencies(names).map((name) => ({ kind: "tool" as const, id: name }));
  if (targets.length === 0) return [];
  return ensureTargets(targets, options);
}

/** Ensure only the tools that were just added to a configuration. */
export async function ensureNewlyEnabledTools(
  before: readonly string[],
  after: readonly string[],
  options: EnsureOptions = {},
): Promise<EnsureOutcome[]> {
  const previous = new Set(before);
  return ensureTools(after.filter((name) => !previous.has(name)), options);
}
