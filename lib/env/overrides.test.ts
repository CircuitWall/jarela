import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envSchemaByName, type EnvVarDef } from "./schema";
import {
  validateForSchema,
  readOverrides,
  readOverridesSync,
  writeOverrides,
  applyOverridesToProcessEnv,
  patchOverride,
} from "./overrides";

// getDataDir() memoizes its result on first call (during app boot, well
// before this test file ever loads), so vi.stubEnv("JARELA_DB_DIR", …)
// alone is not enough to redirect file I/O. Mock the module so each test
// can point overridesPath() at a fresh tmpdir.
const { mockGetDataDir } = vi.hoisted(() => ({ mockGetDataDir: vi.fn<() => string>() }));
vi.mock("@/lib/db/data-dir", () => ({ getDataDir: mockGetDataDir }));

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jarela-env-test-"));
  mockGetDataDir.mockReturnValue(tmp);
});

afterEach(() => {
  vi.unstubAllEnvs();
  mockGetDataDir.mockReset();
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

describe("readOverrides / readOverridesSync", () => {
  const overridesFile = () => join(tmp, "env-overrides.json");

  it("returns EMPTY when the file is missing (ENOENT)", async () => {
    expect(await readOverrides()).toEqual({ version: 1, entries: {} });
    expect(readOverridesSync()).toEqual({ version: 1, entries: {} });
  });

  it("loads a valid file and keeps only schema-known keys", async () => {
    writeFileSync(
      overridesFile(),
      JSON.stringify({
        version: 1,
        entries: {
          JARELA_RUN_IDLE_MS: "5000",
          JARELA_NOT_A_REAL_KEY: "ignored",
          JARELA_LOG_LEVEL: "debug",
        },
      }),
    );
    const out = await readOverrides();
    expect(out.entries).toEqual({
      JARELA_RUN_IDLE_MS: "5000",
      JARELA_LOG_LEVEL: "debug",
    });
    expect(readOverridesSync()).toEqual(out);
  });

  it("drops non-string values defensively", async () => {
    writeFileSync(
      overridesFile(),
      JSON.stringify({
        version: 1,
        entries: { JARELA_RUN_IDLE_MS: 5000, JARELA_LOG_LEVEL: "info" },
      }),
    );
    const out = await readOverrides();
    expect(out.entries).toEqual({ JARELA_LOG_LEVEL: "info" });
    expect(readOverridesSync().entries).toEqual({ JARELA_LOG_LEVEL: "info" });
  });

  it("returns EMPTY on a version mismatch", async () => {
    writeFileSync(overridesFile(), JSON.stringify({ version: 2, entries: { JARELA_LOG_LEVEL: "info" } }));
    expect((await readOverrides()).entries).toEqual({});
    expect(readOverridesSync().entries).toEqual({});
  });

  it("returns EMPTY on a corrupt file (logs a warning)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeFileSync(overridesFile(), "{not valid json");
    try {
      expect((await readOverrides()).entries).toEqual({});
      expect(readOverridesSync().entries).toEqual({});
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("writeOverrides", () => {
  const overridesFile = () => join(tmp, "env-overrides.json");

  it("persists known + valid entries", async () => {
    await writeOverrides({
      version: 1,
      entries: { JARELA_LOG_LEVEL: "warn", JARELA_RUN_IDLE_MS: "5000" },
    });
    expect(existsSync(overridesFile())).toBe(true);
    const written = JSON.parse(readFileSync(overridesFile(), "utf8"));
    expect(written).toEqual({
      version: 1,
      entries: { JARELA_LOG_LEVEL: "warn", JARELA_RUN_IDLE_MS: "5000" },
    });
  });

  it("rejects unknown keys", async () => {
    await expect(
      writeOverrides({ version: 1, entries: { JARELA_NOT_A_KEY: "x" } }),
    ).rejects.toThrow(/unknown env var/);
    expect(existsSync(overridesFile())).toBe(false);
  });

  it("rejects entries that fail schema validation", async () => {
    await expect(
      writeOverrides({ version: 1, entries: { JARELA_RUN_IDLE_MS: "not-an-int" } }),
    ).rejects.toThrow(/JARELA_RUN_IDLE_MS.*integer/);
  });

  it("silently drops non-string values from input", async () => {
    await writeOverrides({
      version: 1,
      // @ts-expect-error intentionally wrong type to exercise the filter
      entries: { JARELA_LOG_LEVEL: "info", JARELA_RUN_IDLE_MS: 5000 },
    });
    const written = JSON.parse(readFileSync(overridesFile(), "utf8"));
    expect(written.entries).toEqual({ JARELA_LOG_LEVEL: "info" });
  });
});

describe("applyOverridesToProcessEnv", () => {
  const overridesFile = () => join(tmp, "env-overrides.json");

  it("applies overrides for unset keys, skips already-set ones", () => {
    writeFileSync(
      overridesFile(),
      JSON.stringify({
        version: 1,
        entries: { JARELA_RUN_IDLE_MS: "5000", JARELA_LOG_LEVEL: "warn" },
      }),
    );
    // Caller already set one — must NOT be overwritten.
    vi.stubEnv("JARELA_RUN_IDLE_MS", "1234");
    delete process.env.JARELA_LOG_LEVEL;
    const result = applyOverridesToProcessEnv();
    expect(result).toEqual({ applied: 1, skipped: 1 });
    expect(process.env.JARELA_RUN_IDLE_MS).toBe("1234");
    expect(process.env.JARELA_LOG_LEVEL).toBe("warn");
  });

  it("treats whitespace-only existing values as unset and applies the override", () => {
    writeFileSync(
      overridesFile(),
      JSON.stringify({ version: 1, entries: { JARELA_LOG_LEVEL: "debug" } }),
    );
    vi.stubEnv("JARELA_LOG_LEVEL", "   ");
    const result = applyOverridesToProcessEnv();
    expect(result).toEqual({ applied: 1, skipped: 0 });
    expect(process.env.JARELA_LOG_LEVEL).toBe("debug");
  });

  it("returns 0/0 when there is no overrides file", () => {
    expect(applyOverridesToProcessEnv()).toEqual({ applied: 0, skipped: 0 });
  });
});

describe("patchOverride", () => {
  const overridesFile = () => join(tmp, "env-overrides.json");

  it("rejects unknown env vars", async () => {
    await expect(patchOverride("JARELA_NOT_A_KEY", "x")).rejects.toThrow(/unknown env var/);
  });

  it("sets a value and persists it", async () => {
    const out = await patchOverride("JARELA_LOG_LEVEL", "warn");
    expect(out.entries).toEqual({ JARELA_LOG_LEVEL: "warn" });
    expect(JSON.parse(readFileSync(overridesFile(), "utf8")).entries).toEqual({
      JARELA_LOG_LEVEL: "warn",
    });
  });

  it("unsets a value when called with null", async () => {
    await patchOverride("JARELA_LOG_LEVEL", "warn");
    const out = await patchOverride("JARELA_LOG_LEVEL", null);
    expect(out.entries).toEqual({});
  });

  it("unsetting a key that isn't there is a no-op", async () => {
    const out = await patchOverride("JARELA_LOG_LEVEL", null);
    expect(out.entries).toEqual({});
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
