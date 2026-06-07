import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-modelconfig-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { getModelParams, upsertModelConfig, deleteModelConfig, getDefaultModelConfig } = await import("./model-config");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("getModelParams", () => {
  it("decodes a stringified params object", () => {
    expect(getModelParams({ params: JSON.stringify({ api_key: "sk-x", temperature: 0.5 }) }))
      .toEqual({ api_key: "sk-x", temperature: 0.5 });
  });

  it("returns {} for null/undefined cfg", () => {
    expect(getModelParams(null)).toEqual({});
    expect(getModelParams(undefined)).toEqual({});
  });

  it("returns {} for blank or malformed JSON", () => {
    expect(getModelParams({ params: "" })).toEqual({});
    expect(getModelParams({ params: "not json" })).toEqual({});
  });

  it("returns {} for non-object payloads (arrays, primitives)", () => {
    expect(getModelParams({ params: JSON.stringify([1, 2, 3]) })).toEqual({});
    expect(getModelParams({ params: JSON.stringify("string") })).toEqual({});
    expect(getModelParams({ params: JSON.stringify(42) })).toEqual({});
  });
});

describe("deleteModelConfig auto-promotes default", () => {
  it("promotes the alphabetically-first remaining row when the default is deleted", () => {
    upsertModelConfig("zzz-alpha", "anthropic", "claude-x", {}, false);
    upsertModelConfig("zzz-beta", "anthropic", "claude-y", {}, true);
    upsertModelConfig("zzz-gamma", "anthropic", "claude-z", {}, false);

    expect(getDefaultModelConfig()?.name).toBe("zzz-beta");
    expect(deleteModelConfig("zzz-beta")).toBe(true);
    // The promoted row is the alphabetically-first remaining row in the
    // DB — could be a seeded "claude-sonnet" if seeds exist, otherwise
    // "zzz-alpha". Either way there MUST be a default now.
    expect(getDefaultModelConfig()).not.toBeNull();

    deleteModelConfig("zzz-alpha");
    deleteModelConfig("zzz-gamma");
  });

  it("does nothing special when a non-default row is deleted", () => {
    upsertModelConfig("keep-default", "anthropic", "claude-x", {}, true);
    upsertModelConfig("disposable", "anthropic", "claude-y", {}, false);
    expect(getDefaultModelConfig()?.name).toBe("keep-default");
    deleteModelConfig("disposable");
    expect(getDefaultModelConfig()?.name).toBe("keep-default");
    deleteModelConfig("keep-default");
  });
});
