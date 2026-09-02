import { describe, it, expect, vi, afterEach } from "vitest";
import { createKeyedCache } from "./keyed-cache";

afterEach(() => vi.useRealTimers());

describe("createKeyedCache", () => {
  it("computes once and serves the same value while fresh", () => {
    const load = vi.fn(() => ({ n: 1 }));
    const cache = createKeyedCache({ ttlMs: 1000, load });

    const first = cache.get();

    expect(cache.get()).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("recomputes after the ttl expires", () => {
    vi.useFakeTimers();
    const load = vi.fn(() => ({ n: 1 }));
    const cache = createKeyedCache({ ttlMs: 1000, load });

    cache.get();
    vi.advanceTimersByTime(1001);
    cache.get();

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("recomputes immediately when the key changes, ignoring the ttl", () => {
    let key = "a";
    const load = vi.fn(() => key);
    const cache = createKeyedCache({ ttlMs: 60_000, load, key: () => key });

    expect(cache.get()).toBe("a");
    key = "b";

    expect(cache.get()).toBe("b");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("recomputes after invalidate even when fresh", () => {
    const load = vi.fn(() => ({ n: 1 }));
    const cache = createKeyedCache({ ttlMs: 60_000, load });

    cache.get();
    cache.invalidate();
    cache.get();

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("treats a returning key as a hit again", () => {
    let key = "a";
    const load = vi.fn(() => key);
    const cache = createKeyedCache({ ttlMs: 60_000, load, key: () => key });

    cache.get();
    key = "b";
    cache.get();
    key = "a";

    // Only one entry is retained, so going back is a miss, not a stale hit.
    expect(cache.get()).toBe("a");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("does not cache a throwing load", () => {
    let fail = true;
    const load = vi.fn(() => {
      if (fail) throw new Error("boom");
      return "ok";
    });
    const cache = createKeyedCache({ ttlMs: 60_000, load });

    expect(() => cache.get()).toThrow("boom");
    fail = false;

    expect(cache.get()).toBe("ok");
  });
});
