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
    expect(cfg.heuristics.high_entropy.min_length).toBe(16);
    expect(cfg.heuristics.digit_run?.enabled).toBe(true);
    expect(cfg.heuristics.digit_run?.min_digits).toBe(8);
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
    expect(cfg.patterns[0].name).toBe("custom");
    expect(cfg.patterns.map((p) => p.name)).toEqual([
      "custom",
      ...DEFAULT_REDACTION_CONFIG.patterns.map((p) => p.name),
    ]);
    expect(cfg.heuristics.high_entropy.enabled).toBe(false);
    expect(cfg.field_name_allowlist).toEqual(["my_id"]);
  });

  it("keeps digit_run on for pattern files written before it existed", () => {
    writeFileSync(
      getRedactionConfigPath(),
      JSON.stringify({
        patterns: [],
        heuristics: {
          high_entropy: {
            enabled: true,
            min_length: 16,
            min_entropy: 4.0,
            char_class: "[A-Za-z0-9_=+/.-]",
            exclude_patterns: [],
          },
        },
      }),
    );
    const cfg = loadRedactionConfig();
    expect(cfg.heuristics.digit_run).toEqual(DEFAULT_REDACTION_CONFIG.heuristics.digit_run);
  });

  it("upgrades retired default entropy excludes but keeps user excludes", () => {
    writeFileSync(
      getRedactionConfigPath(),
      JSON.stringify({
        patterns: [],
        heuristics: {
          high_entropy: {
            ...DEFAULT_REDACTION_CONFIG.heuristics.high_entropy,
            exclude_patterns: ["^[a-f0-9]{40}$", "^[a-z]{2,8}_[A-Za-z0-9]{14,}$", "^my-own-[0-9]+$"],
          },
        },
      }),
    );
    expect(loadRedactionConfig().heuristics.high_entropy.exclude_patterns).toEqual([
      "^(?:\\w+=)?[a-f0-9]{40}$",
      "^[a-z]{2,8}_[A-Za-z0-9]{14,24}$",
      "^my-own-[0-9]+$",
    ]);
  });

  it("respects an explicitly disabled digit_run or built-in pattern", () => {
    writeFileSync(
      getRedactionConfigPath(),
      JSON.stringify({
        patterns: [{ ...DEFAULT_REDACTION_CONFIG.patterns[0], enabled: false }],
        heuristics: {
          high_entropy: DEFAULT_REDACTION_CONFIG.heuristics.high_entropy,
          digit_run: { ...DEFAULT_REDACTION_CONFIG.heuristics.digit_run, enabled: false },
        },
      }),
    );
    const cfg = loadRedactionConfig();
    expect(cfg.heuristics.digit_run.enabled).toBe(false);
    const first = cfg.patterns.filter((p) => p.name === DEFAULT_REDACTION_CONFIG.patterns[0].name);
    expect(first).toHaveLength(1);
    expect(first[0].enabled).toBe(false);
    expect(cfg.patterns).toHaveLength(DEFAULT_REDACTION_CONFIG.patterns.length);
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
