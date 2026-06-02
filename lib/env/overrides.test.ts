import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envSchemaByName, type EnvVarDef } from "./schema";
import { validateForSchema } from "./overrides";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jarela-env-test-"));
  vi.stubEnv("JARELA_DB_DIR", tmp);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe("env-overrides validateForSchema", () => {
  const intDef: EnvVarDef = {
    name: "JARELA_RUN_IDLE_MS",
    type: "int",
    default: 90_000,
    description: "",
    category: "agent",
    tier: "B",
    requiresRestart: false,
    agentWritable: true,
    min: 1_000,
  };

  it("accepts valid integers within range", () => {
    expect(validateForSchema(intDef, "5000")).toBeNull();
  });

  it("rejects non-integers", () => {
    expect(validateForSchema(intDef, "abc")).toMatch(/integer/);
    expect(validateForSchema(intDef, "5.5")).toMatch(/integer/);
  });

  it("enforces min", () => {
    expect(validateForSchema(intDef, "100")).toMatch(/minimum/);
  });

  it("accepts bool 0/1/true/false", () => {
    const def = envSchemaByName().get("JARELA_DISABLE_UPDATE_CHECK");
    expect(def).toBeDefined();
    if (!def) return;
    expect(validateForSchema(def, "true")).toBeNull();
    expect(validateForSchema(def, "0")).toBeNull();
    expect(validateForSchema(def, "yes")).toMatch(/bool/);
  });

  it("enforces enum values", () => {
    const def = envSchemaByName().get("JARELA_LOG_LEVEL");
    expect(def).toBeDefined();
    if (!def) return;
    expect(validateForSchema(def, "info")).toBeNull();
    expect(validateForSchema(def, "INFO")).toMatch(/expected one of/);
    expect(validateForSchema(def, "trace")).toMatch(/expected one of/);
  });
});

describe("schema sanity", () => {
  it("every entry has a unique JARELA_-prefixed name", () => {
    const names = new Set<string>();
    for (const def of envSchemaByName().values()) {
      expect(def.name.startsWith("JARELA_")).toBe(true);
      expect(names.has(def.name)).toBe(false);
      names.add(def.name);
    }
  });

  it("every int default is within its declared min/max", () => {
    for (const def of envSchemaByName().values()) {
      if (def.type !== "int") continue;
      const n = Number(def.default);
      if (def.min !== undefined) expect(n).toBeGreaterThanOrEqual(def.min);
      if (def.max !== undefined) expect(n).toBeLessThanOrEqual(def.max);
    }
  });

  it("every enum default is in its enumValues list", () => {
    for (const def of envSchemaByName().values()) {
      if (def.type !== "enum") continue;
      expect(def.enumValues).toBeDefined();
      if (!def.enumValues) continue;
      expect(def.enumValues.includes(String(def.default))).toBe(true);
    }
  });
});
