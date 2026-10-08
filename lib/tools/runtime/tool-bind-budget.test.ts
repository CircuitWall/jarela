import { describe, expect, it } from "vitest";
import { applyToolBindBudget } from "./catalog";

const names = ["a", "b", "c", "d", "e", "f"];

describe("applyToolBindBudget", () => {
  it("is a no-op when disabled or under budget", () => {
    expect(applyToolBindBudget(names, { budget: 0, alwaysKeep: [], recentlyUsed: [], pinned: [] })).toEqual(names);
    expect(applyToolBindBudget(names, { budget: 6, alwaysKeep: [], recentlyUsed: [], pinned: [] })).toEqual(names);
  });

  it("keeps always-keep tools first, then recently used, then pinned, then the rest", () => {
    const out = applyToolBindBudget(names, { budget: 4, alwaysKeep: ["f", "missing"], recentlyUsed: ["d", "b"], pinned: ["c"] });
    expect(out).toEqual(["b", "c", "d", "f"]);
  });

  it("binds pinned tools ahead of basic defaults that come earlier in the catalog", () => {
    const out = applyToolBindBudget(names, { budget: 3, alwaysKeep: [], recentlyUsed: [], pinned: ["e", "f"] });
    expect(out).toEqual(["a", "e", "f"]);
  });

  it("never exceeds the budget and preserves input order for cache stability", () => {
    const out = applyToolBindBudget(names, { budget: 2, alwaysKeep: ["e", "a", "c"], recentlyUsed: ["b"], pinned: [] });
    expect(out).toEqual(["a", "e"]);
  });

  it("ignores recently used tools the agent is not permitted to bind", () => {
    const out = applyToolBindBudget(names, { budget: 3, alwaysKeep: [], recentlyUsed: ["zzz", "e"], pinned: [] });
    expect(out).toEqual(["a", "b", "e"]);
  });
});
