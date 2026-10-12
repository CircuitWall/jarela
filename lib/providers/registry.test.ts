import { describe, expect, it } from "vitest";
import "./builtins";
import { getBuiltinProviderNames, getBuiltinProviders, registerBuiltinProvider } from "./registry";

describe("built-in provider registry", () => {
  it("derives provider names from the imported provider modules", () => {
    const providers = getBuiltinProviders();
    const names = [...getBuiltinProviderNames()];
    expect([...names].sort()).toEqual(Object.values(providers).map((provider) => provider.name).sort());
    expect(new Set(names).size).toBe(names.length);
    for (const [name, provider] of Object.entries(providers)) {
      expect(provider.name).toBe(name);
    }
  });

  it("rejects duplicate provider names", () => {
    const openai = getBuiltinProviders().openai;
    expect(() => registerBuiltinProvider({ ...openai })).toThrow(/duplicate built-in provider registration/i);
  });
});