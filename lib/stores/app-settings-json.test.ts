import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-settings-json-"));
process.env.JARELA_DB_DIR = tmpRoot;
const { closeDb, getDb } = await import("@/lib/db");
const { readJsonSetting } = await import("./app-settings-json");
const {
  getEmbeddingModelConfigName, setEmbeddingModelConfigName, getScreenLockIdleTimeoutMs,
  isRedactionEnabled, isAmbientContextEnabled, getSkillExecutionPolicy, getDocumentRecallPolicy,
} = await import("./app-settings");
const { getDefaultHarnessId, listAllHarnesses } = await import("./harnesses");
const { DEFAULT_HARNESS_ID } = await import("@/lib/agents/harness/types");

function store(key: string, value: string, namespace = "app-settings") {
  getDb().prepare(
    "INSERT OR REPLACE INTO memory_store(namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,NULL)",
  ).run(namespace, key, value, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z");
}

beforeEach(() => getDb().exec("DELETE FROM memory_store"));
afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("tolerant app-settings JSON", () => {
  it("reads only its namespace and returns null for absent or malformed values", () => {
    store("synthetic", '"foreign"', "synthetic-namespace");
    expect(readJsonSetting("synthetic")).toBeNull();
    for (const raw of ["", "{", "null"]) {
      store("synthetic", raw);
      expect(readJsonSetting("synthetic")).toBeNull();
    }
  });

  it.each([false, 0, "", [], { synthetic: true }])("retains valid JSON values without schema coercion: %j", (value) => {
    store("synthetic", JSON.stringify(value));
    expect(readJsonSetting("synthetic")).toEqual(value);
  });

  it.each(["", "{", "null", "0", '""', "{}", "true", "false"])("preserves default-on toggles except explicit false: %s", (raw) => {
    for (const key of ["redaction_enabled", "ambient_context_enabled"]) store(key, raw);
    expect(isRedactionEnabled()).toBe(raw !== "false");
    expect(isAmbientContextEnabled()).toBe(raw !== "false");
  });

  it.each([
    ["0", 0], ["15.9", 15], ["-1", null], ["1e999", null], ['"100"', null], ["{", null],
  ])("retains idle-timeout numeric validation: %s", (raw, expected) => {
    store("screen_lock_idle_timeout_ms", raw);
    expect(getScreenLockIdleTimeoutMs()).toBe(expected);
  });

  it("preserves embedding-setting creation time, update time and deletion", () => {
    expect(setEmbeddingModelConfigName("synthetic-model")).toBe("synthetic-model");
    const first = getDb().prepare("SELECT created_at FROM memory_store WHERE key=?").get("embedding_model_config");
    const time = "2026-11-01T00:00:00.000Z";
    const iso = vi.spyOn(Date.prototype, "toISOString").mockReturnValue(time);
    try {
      setEmbeddingModelConfigName("synthetic-next");
      expect(getEmbeddingModelConfigName()).toBe("synthetic-next");
      expect(getDb().prepare("SELECT created_at,updated_at,embedding FROM memory_store WHERE key=?").get("embedding_model_config"))
        .toEqual({ ...first, updated_at: time, embedding: null });
    } finally {
      iso.mockRestore();
    }
    expect(setEmbeddingModelConfigName(null)).toBeNull();
    expect(getEmbeddingModelConfigName()).toBeNull();
  });

  it("keeps corrupt custom harness settings tolerant and default selection stable", () => {
    const builtins = listAllHarnesses();
    store("harnesses", "{");
    store("default_harness_id", "{");
    expect(listAllHarnesses()).toEqual(builtins);
    expect(getDefaultHarnessId()).toBe(DEFAULT_HARNESS_ID);
    store("default_harness_id", '"synthetic-custom"');
    expect(getDefaultHarnessId()).toBe("synthetic-custom");
  });

  it.each(["skill_execution_policy", "document_recall_policy"])("keeps %s strict on corrupt JSON and invalid schemas", (key) => {
    const read = key === "skill_execution_policy" ? getSkillExecutionPolicy : getDocumentRecallPolicy;
    store(key, "{");
    expect(read).toThrow(SyntaxError);
    store(key, "{}");
    expect(read).toThrow();
  });

  it("propagates database failures instead of returning a successful-looking fallback", () => {
    const prepare = vi.spyOn(getDb(), "prepare").mockImplementation(() => { throw new Error("Synthetic DB failure"); });
    try {
      expect(() => readJsonSetting("synthetic")).toThrow("Synthetic DB failure");
    } finally {
      prepare.mockRestore();
    }
  });
});
