/**
 * Package auth resolver registry.
 *
 * `registerLangChainPackage`'s `auth` block produces a `resolveAuth()`
 * function that walks env → DB → not-configured-error. Modules outside
 * the registering file (health probes, document-RAG indexers in
 * lib/documents/remote/*) used to import per-adapter
 * `_resolveAtlassianAuth` / `_resolveGithubAuth` re-exports to call it.
 *
 * That tight coupling is gone now: `setPackageAuthResolver(id, fn)` is
 * called once per package at registration time, and any cross-module
 * caller looks it up via `resolvePackageAuth<T>(id)`. The integration
 * id matches the key in `INTEGRATIONS` (lib/stores/integrations.ts) so
 * the same string drives the credentials panel, the DB row, and the
 * auth probe.
 */

type Resolver<T> = () => T | { error: string };

const resolvers = new Map<string, Resolver<unknown>>();

export function setPackageAuthResolver<T>(id: string, fn: Resolver<T>): void {
  resolvers.set(id, fn as Resolver<unknown>);
}

export function resolvePackageAuth<T>(id: string): T | { error: string } {
  const fn = resolvers.get(id);
  if (!fn) {
    return { error: `package "${id}" is not registered (no auth resolver available)` };
  }
  return fn() as T | { error: string };
}

/** @internal — test-only. */
export function _clearPackageAuthResolvers(): void {
  resolvers.clear();
}

/** @internal — test-only. */
export function _listRegisteredPackageAuthIds(): string[] {
  return [...resolvers.keys()].sort();
}
