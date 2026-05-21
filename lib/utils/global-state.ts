// Pin a piece of state to globalThis so it survives Next.js dev hot-reload.
//
// Without this, every code edit re-evaluates the module, replacing the
// in-memory state with empty containers — but any active closure still
// references the OLD set, so listeners/timers/maps go silently dead.
// The globalThis trick is the standard Next pattern for singletons.
//
// `key` must be unique across the app (it lives on globalThis); pick a
// "__jarela_<name>" prefix to keep the namespace tidy.
export function getOrCreateGlobal<T>(key: string, factory: () => T): T {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g[key] === undefined) g[key] = factory();
  return g[key] as T;
}
