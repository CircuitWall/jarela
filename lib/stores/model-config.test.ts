import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-modelconfig-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { getModelParams } = await import("./model-config");

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
