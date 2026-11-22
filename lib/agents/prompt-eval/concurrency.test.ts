/**
 * The pool is what makes a twelve-minute evaluation fit in a review loop, so
 * its bounds are pinned: a fan-out above the provider's comfort zone would
 * trade wall time for rate-limit failures.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, mapPool, resolveConcurrency } from "./concurrency";

describe("resolveConcurrency", () => {
  it("falls back for missing or unusable overrides", () => {
    expect(resolveConcurrency(undefined)).toBe(DEFAULT_CONCURRENCY);
    expect(resolveConcurrency("")).toBe(DEFAULT_CONCURRENCY);
    expect(resolveConcurrency("0")).toBe(DEFAULT_CONCURRENCY);
    expect(resolveConcurrency("-2")).toBe(DEFAULT_CONCURRENCY);
    expect(resolveConcurrency("abc")).toBe(DEFAULT_CONCURRENCY);
    expect(resolveConcurrency("2.5")).toBe(DEFAULT_CONCURRENCY);
  });

  it("honours a valid override and caps the fan-out", () => {
    expect(resolveConcurrency("1")).toBe(1);
    expect(resolveConcurrency("4")).toBe(4);
    expect(resolveConcurrency(String(MAX_CONCURRENCY + 10))).toBe(MAX_CONCURRENCY);
  });
});

describe("mapPool", () => {
  it("runs every item once, in order of delivery, with its index", async () => {
    const seen: Array<{ item: number; index: number }> = [];
    await mapPool([10, 20, 30, 40], 2, async (item, index) => {
      seen.push({ item, index });
    });
    expect(seen.map(({ item }) => item).sort((a, b) => a - b)).toEqual([10, 20, 30, 40]);
    expect(seen.map(({ index }) => index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("never exceeds the requested concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 12 }, (_, index) => index), 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    });
    expect(peak).toBe(3);
  });

  it("handles a limit larger than the item count", async () => {
    let calls = 0;
    await mapPool([1, 2], 6, async () => {
      calls += 1;
    });
    expect(calls).toBe(2);
  });

  it("rejects the pool when a worker throws", async () => {
    await expect(mapPool([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error("provider down");
    })).rejects.toThrow("provider down");
  });
});
