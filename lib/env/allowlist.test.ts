import { describe, it, expect } from "vitest";
import { ENV_ALLOWLIST, getAllEnvVarNames } from "./allowlist";

describe("ENV_ALLOWLIST", () => {
  it("every mapping has at least one envVar and a non-empty integration + field", () => {
    for (const m of ENV_ALLOWLIST) {
      expect(m.envVars.length).toBeGreaterThan(0);
      expect(m.integration).toBeTruthy();
      expect(m.field).toBeTruthy();
    }
  });

  it("envVar names are unique across the allowlist (no name maps to two integrations)", () => {
    const seen = new Set<string>();
    for (const m of ENV_ALLOWLIST) {
      for (const name of m.envVars) {
        expect(seen.has(name)).toBe(false);
        seen.add(name);
      }
    }
  });
});

describe("getAllEnvVarNames", () => {
  it("returns every env var across mappings", () => {
    const names = getAllEnvVarNames();
    expect(names).toContain("GITHUB_TOKEN");
    expect(names).toContain("GH_TOKEN");
    expect(names).toContain("ATLASSIAN_API_TOKEN");
    expect(names).toContain("GOOGLE_API_KEY");
    expect(names).toContain("GEMINI_API_KEY");
  });

  it("dedupes (returns each name only once)", () => {
    const names = getAllEnvVarNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it("size matches the flat union of every mapping's envVars", () => {
    const expected = new Set<string>();
    for (const m of ENV_ALLOWLIST) for (const n of m.envVars) expected.add(n);
    expect(getAllEnvVarNames().length).toBe(expected.size);
  });
});
