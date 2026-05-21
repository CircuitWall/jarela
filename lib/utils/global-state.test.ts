import { describe, it, expect, vi, afterEach } from "vitest";
import { getOrCreateGlobal } from "./global-state";

afterEach(() => {
  // Tests pin keys to globalThis; clean up so each test starts fresh.
  for (const k of ["__test_a", "__test_b", "__test_c"]) {
    delete (globalThis as unknown as Record<string, unknown>)[k];
  }
});

describe("getOrCreateGlobal", () => {
  it("invokes the factory once and caches the result", () => {
    const factory = vi.fn(() => ({ count: 1 }));
    const a = getOrCreateGlobal("__test_a", factory);
    const b = getOrCreateGlobal("__test_a", factory);
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("scopes by key — different keys get different values", () => {
    const a = getOrCreateGlobal("__test_a", () => "first");
    const b = getOrCreateGlobal("__test_b", () => "second");
    expect(a).toBe("first");
    expect(b).toBe("second");
  });

  it("preserves mutations across calls (singleton semantics)", () => {
    const initial = getOrCreateGlobal<{ items: string[] }>("__test_c", () => ({ items: [] }));
    initial.items.push("x");
    const reread = getOrCreateGlobal<{ items: string[] }>("__test_c", () => ({ items: [] }));
    expect(reread.items).toEqual(["x"]);
  });
});
