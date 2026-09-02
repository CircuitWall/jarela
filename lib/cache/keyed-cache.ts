/**
 * Keyed TTL cache for synchronous, expensive-to-recompute values.
 *
 * Several modules had grown their own copy of the same three lines — a
 * timestamped slot, a TTL comparison and a reset function — each with its own
 * subtly different reset name and its own tests for the same mechanics. The
 * bugs that pattern invites are always the same two: forgetting to invalidate
 * on a write, and forgetting that a value depends on something other than
 * time (a repo set, a directory list) so a stale entry survives a config
 * change.
 *
 * This encodes both. `key` is recomputed on every read and any change misses
 * the cache immediately; the TTL only bounds staleness from changes the key
 * cannot see, such as a file edited outside the app.
 */
export interface KeyedCacheOptions<T> {
  /** How long a value may be served without revalidation. */
  ttlMs: number;
  /** Produces the value. Called on a miss. */
  load: () => T;
  /**
   * Identity of everything the value depends on besides time. A change here
   * bypasses the TTL. Omit only when nothing but time can invalidate.
   */
  key?: () => string;
}

export interface KeyedCache<T> {
  get(): T;
  invalidate(): void;
}

export function createKeyedCache<T>({ ttlMs, load, key }: KeyedCacheOptions<T>): KeyedCache<T> {
  let entry: { value: T; ts: number; key: string } | null = null;

  return {
    get(): T {
      const currentKey = key ? key() : "";
      const now = Date.now();
      if (entry && entry.key === currentKey && now - entry.ts < ttlMs) {
        return entry.value;
      }
      const value = load();
      entry = { value, ts: now, key: currentKey };
      return value;
    },
    invalidate(): void {
      entry = null;
    },
  };
}

/**
 * Bounded content-addressed cache for values that are a pure function of their
 * key, such as an embedding vector for a piece of text. No TTL: the mapping
 * cannot go stale, so the only bound needed is memory. Callers must include
 * anything that changes the mapping (a model id, say) in the key.
 *
 * Eviction is least-recently-used, relying on Map preserving insertion order:
 * a hit re-inserts, so the oldest key is always first.
 */
export interface ContentCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  has(key: string): boolean;
  readonly size: number;
  clear(): void;
}

export function createContentCache<T>(maxEntries: number): ContentCache<T> {
  const entries = new Map<string, T>();

  return {
    get(key: string): T | undefined {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key) as T;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key: string, value: T): void {
      if (entries.has(key)) entries.delete(key);
      entries.set(key, value);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    has(key: string): boolean {
      return entries.has(key);
    },
    get size(): number {
      return entries.size;
    },
    clear(): void {
      entries.clear();
    },
  };
}
