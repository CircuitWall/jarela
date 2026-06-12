import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "jarela-redaction-"));

vi.mock("@/lib/db/data-dir", () => ({
  getDataDir: () => tempDir,
}));

import {
  DEFAULT_REDACTION_CONFIG,
  clearRedactionConfigCache,
  ensureRedactionConfigFile,
  getRedactionConfigPath,
  loadRedactionConfig,
} from "./patterns";

describe("loadRedactionConfig", () => {
  beforeEach(() => clearRedactionConfigCache());

  afterEach(() => {
    try { rmSync(getRedactionConfigPath()); } catch { /* */ }
    clearRedactionConfigCache();
  });

  it("returns the baked-in defaults when no file exists", () => {
    const cfg = loadRedactionConfig();
    expect(cfg.patterns.find((p) => p.name === "anthropic_api_key")).toBeDefined();
    expect(cfg.heuristics.high_entropy.min_length).toBe(32);
  });

  it("reads a user-provided config file when present", () => {
    writeFileSync(
      getRedactionConfigPath(),
      JSON.stringify({
        patterns: [
          {
            name: "custom",
            regex: "CUSTOM-[A-Z]+",
            type_hint: "custom_thing",
            enabled: true,
          },
        ],
        heuristics: {
          high_entropy: {
            enabled: false,
            min_length: 64,
            min_entropy: 5.0,
            char_class: "[A-Z]",
            exclude_patterns: [],
          },
        },
        field_name_allowlist: ["my_id"],
      }),
    );
    const cfg = loadRedactionConfig();
    expect(cfg.patterns).toHaveLength(1);
    expect(cfg.patterns[0].name).toBe("custom");
    expect(cfg.heuristics.high_entropy.enabled).toBe(false);
    expect(cfg.field_name_allowlist).toEqual(["my_id"]);
  });

  it("falls back to defaults on invalid JSON", () => {
    writeFileSync(getRedactionConfigPath(), "{ not valid json");
    const cfg = loadRedactionConfig();
    expect(cfg).toBe(DEFAULT_REDACTION_CONFIG);
  });

  it("falls back to defaults on schema mismatch", () => {
    writeFileSync(
      getRedactionConfigPath(),
      JSON.stringify({ patterns: "not an array" }),
    );
    const cfg = loadRedactionConfig();
    expect(cfg).toBe(DEFAULT_REDACTION_CONFIG);
  });
});

describe("ensureRedactionConfigFile", () => {
  beforeEach(() => clearRedactionConfigCache());
  afterEach(() => {
    try { rmSync(getRedactionConfigPath()); } catch { /* */ }
  });

  it("writes the default config when no file exists", () => {
    const path = ensureRedactionConfigFile();
    expect(path).toBe(getRedactionConfigPath());
    const cfg = loadRedactionConfig();
    expect(cfg.patterns.length).toBe(DEFAULT_REDACTION_CONFIG.patterns.length);
  });
});
