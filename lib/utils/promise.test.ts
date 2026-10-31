import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleWithinBudget } from "./promise";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("settleWithinBudget", () => {
  it("returns the successful value and clears its deadline timer", async () => {
    const value = { text: "Synthetic context" };
    await expect(settleWithinBudget(Promise.resolve(value), 100, { text: "" })).resolves.toBe(value);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the fallback on rejection and clears its deadline timer", async () => {
    const fallback: string[] = [];
    await expect(settleWithinBudget(Promise.reject(new Error("Synthetic failure")), 100, fallback)).resolves.toBe(fallback);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits until the exact deadline and ignores a later success", async () => {
    const pending = deferred<string>();
    const result = settleWithinBudget(pending.promise, 100, "fallback");
    const settled = vi.fn();
    void result.then(settled);
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("fallback");
    pending.resolve("late");
    await Promise.resolve();
    expect(settled).toHaveBeenCalledExactlyOnceWith("fallback");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles a late rejection without leaking a timer or an unhandled rejection", async () => {
    const pending = deferred<string>();
    const result = settleWithinBudget(pending.promise, 100, "fallback");
    await vi.advanceTimersByTimeAsync(100);
    pending.reject(new Error("Synthetic late failure"));
    await expect(result).resolves.toBe("fallback");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets an already-resolved promise beat the zero-budget timer", async () => {
    await expect(settleWithinBudget(Promise.resolve("ready"), 0, "fallback")).resolves.toBe("ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1])("uses a timer rather than unlimited waiting for budget %i", async (budget) => {
    const pending = deferred<string>();
    const result = settleWithinBudget(pending.promise, budget, "fallback");
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe("fallback");
    pending.resolve("late");
  });
});
