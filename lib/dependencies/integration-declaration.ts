/**
 * Integration → dependency declarations.
 *
 * The tool catalog needs "which dependencies does this integration need?" on a
 * hot, synchronous path. Importing `lib/integrations/registry` from there would
 * pull every manifest (and, through it, stores) into the tool-registry module
 * graph and re-introduce a module cycle. Instead the integrations layer pushes
 * its declarations here at load time, mirroring `lib/tools/runtime/auth-registry`.
 */
import type { DependencySpec } from "./schema";

const declarations = new Map<string, readonly DependencySpec[]>();

export function registerIntegrationDependencies(
  integrationId: string,
  dependencies: readonly DependencySpec[] | undefined,
): void {
  if (!dependencies || dependencies.length === 0) {
    declarations.delete(integrationId);
    return;
  }
  declarations.set(integrationId, dependencies);
}

export function getIntegrationDependencies(integrationId: string): readonly DependencySpec[] {
  return declarations.get(integrationId) ?? [];
}

/** @internal — test-only: drop declarations so a fresh registry can re-register. */
export function _resetIntegrationDependencies(): void {
  declarations.clear();
}
