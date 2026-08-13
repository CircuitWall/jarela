import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated SQLite per test process; the override store opens the DB on
// first import. Set JARELA_DB_DIR before importing the module under test.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-allowlist-"));
process.env.JARELA_DB_DIR = tmpRoot;
process.on("exit", () => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

const {
  ENV_ALLOWLIST,
  getAllEnvVarNames,
  getEffectiveAllowlist,
  getInjectedSubprocessEnv,
  getOverride,
  setOverride,
  deleteOverride,
  listOverrides,
} = await import("./allowlist");
const { saveIntegration, deleteIntegration } = await import("@/lib/stores/integrations");

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

  it("includes ANTHROPIC_API_KEY → anthropic.api_key", () => {
    const m = ENV_ALLOWLIST.find((x) => x.integration === "anthropic" && x.field === "api_key");
    expect(m).toBeDefined();
    expect(m!.envVars).toContain("ANTHROPIC_API_KEY");
  });
});

describe("getAllEnvVarNames (no overrides)", () => {
  it("returns every default env var", () => {
    const names = getAllEnvVarNames();
    expect(names).toContain("GITHUB_TOKEN");
    expect(names).toContain("GH_TOKEN");
    expect(names).toContain("ATLASSIAN_API_TOKEN");
    expect(names).toContain("GOOGLE_API_KEY");
    expect(names).toContain("GEMINI_API_KEY");
    expect(names).toContain("ANTHROPIC_API_KEY");
    expect(names).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(names).toContain("ANTHROPIC_BASE_URL");
    expect(names).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL");
    expect(names).toContain("ANTHROPIC_DEFAULT_SONNET_MODEL");
    expect(names).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL");
  });

  it("dedupes (returns each name only once)", () => {
    const names = getAllEnvVarNames();
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("setOverride / getOverride", () => {
  beforeEach(() => {
    // Fresh state for each test: drop every override row.
    for (const k of Object.keys(listOverrides())) {
      const [integration, field] = k.split(":");
      deleteOverride(integration, field);
    }
  });

  it("rejects an unknown integration", () => {
    const r = setOverride("does-not-exist", "api_key", ["FOO"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown integration/);
  });

  it("rejects an unknown field on a known integration", () => {
    const r = setOverride("anthropic", "not_a_field", ["FOO"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown field/);
  });

  it("rejects an invalid env var name (lowercase, dashes)", () => {
    const r = setOverride("anthropic", "api_key", ["my-key"]);
    expect(r.ok).toBe(false);
  });

  it("uppercases, dedupes, and strips defaults from the persisted payload", () => {
    const r = setOverride("anthropic", "api_key", [
      "ANTHROPIC_API_KEY", // already a default — should be stripped
      "my_other_key",      // should be uppercased
      "MY_OTHER_KEY",      // dup of above after uppercasing
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.envVars).toEqual(["MY_OTHER_KEY"]);
    expect(getOverride("anthropic", "api_key")).toEqual(["MY_OTHER_KEY"]);
  });

  it("an empty override list deletes the row", () => {
    setOverride("anthropic", "api_key", ["MY_KEY"]);
    expect(getOverride("anthropic", "api_key")).toEqual(["MY_KEY"]);
    const r = setOverride("anthropic", "api_key", []);
    expect(r.ok).toBe(true);
    expect(getOverride("anthropic", "api_key")).toEqual([]);
  });
});

describe("getEffectiveAllowlist", () => {
  beforeEach(() => {
    for (const k of Object.keys(listOverrides())) {
      const [integration, field] = k.split(":");
      deleteOverride(integration, field);
    }
  });

  it("returns the defaults verbatim when no overrides are stored", () => {
    const effective = getEffectiveAllowlist();
    expect(effective.length).toBe(ENV_ALLOWLIST.length);
    for (let i = 0; i < ENV_ALLOWLIST.length; i++) {
      expect(effective[i].integration).toBe(ENV_ALLOWLIST[i].integration);
      expect(effective[i].field).toBe(ENV_ALLOWLIST[i].field);
      expect(effective[i].envVars).toEqual([...ENV_ALLOWLIST[i].envVars]);
    }
  });

  it("appends override aliases after the defaults", () => {
    setOverride("github", "token", ["MY_GH_PAT"]);
    const m = getEffectiveAllowlist().find((x) => x.integration === "github" && x.field === "token");
    expect(m!.envVars).toEqual(["GITHUB_TOKEN", "GH_TOKEN", "MY_GH_PAT"]);
  });

  it("getAllEnvVarNames sees override-added names", () => {
    setOverride("anthropic", "api_key", ["MY_ANT_KEY"]);
    expect(getAllEnvVarNames()).toContain("MY_ANT_KEY");
    expect(getAllEnvVarNames()).toContain("ANTHROPIC_API_KEY");
  });
});

describe("getInjectedSubprocessEnv", () => {
  beforeEach(() => {
    for (const k of Object.keys(listOverrides())) {
      const [integration, field] = k.split(":");
      deleteOverride(integration, field);
    }
    // Wipe any stored integration credentials between tests.
    for (const def of ["anthropic", "claude-code", "github", "atlassian", "google"]) {
      deleteIntegration(def);
    }
  });

  it("returns an empty object when no integrations are configured", () => {
    expect(getInjectedSubprocessEnv()).toEqual({});
  });

  it("renders a stored anthropic key under every default alias", () => {
    saveIntegration("anthropic", { api_key: "sk-ant-test" });
    const env = getInjectedSubprocessEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
  });

  it("renders a stored github token under every default alias (canonical + GH_TOKEN)", () => {
    saveIntegration("github", { token: "ghp_abc" });
    const env = getInjectedSubprocessEnv();
    expect(env.GITHUB_TOKEN).toBe("ghp_abc");
    expect(env.GH_TOKEN).toBe("ghp_abc");
  });

  it("renders a stored value under override aliases too", () => {
    saveIntegration("anthropic", { api_key: "sk-ant-rotation" });
    setOverride("anthropic", "api_key", ["MY_ANT_KEY"]);
    const env = getInjectedSubprocessEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-rotation");
    expect(env.MY_ANT_KEY).toBe("sk-ant-rotation");
  });

  it("skips fields that aren't stored", () => {
    saveIntegration("anthropic", { api_key: "sk-ant" });
    const env = getInjectedSubprocessEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("projects Claude Code optional Anthropic runtime vars into subprocess env", () => {
    saveIntegration("claude-code", {
      auth_token: "auth_cli_token",
      base_url: "https://proxy.anthropic.example",
      default_opus_model: "claude-opus-custom",
      default_sonnet_model: "claude-sonnet-custom",
      default_haiku_model: "claude-haiku-custom",
    });
    const env = getInjectedSubprocessEnv();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("auth_cli_token");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.anthropic.example");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-custom");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-custom");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-custom");
  });
});
