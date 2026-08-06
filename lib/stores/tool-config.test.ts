import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-tool-config-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  getToolConfig,
  setToolConfig,
  deleteToolConfig,
  describeToolConfig,
} = await import("./tool-config");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe("tool-config store", () => {
  beforeEach(() => {
    // Clean up any persisted values between tests
    deleteToolConfig("mytool", "base_url");
    deleteToolConfig("mytool", "timeout_ms");
    deleteToolConfig("mytool", "enabled");
  });

  it("missing entry returns null", () => {
    expect(getToolConfig("mytool", "base_url")).toBeNull();
  });

  it("set then get round-trips plain strings", () => {
    setToolConfig("mytool", "base_url", "https://api.example.com/v1");
    expect(getToolConfig("mytool", "base_url")).toBe("https://api.example.com/v1");
  });

  it("set then get round-trips numeric strings", () => {
    setToolConfig("mytool", "timeout_ms", "5000");
    expect(getToolConfig("mytool", "timeout_ms")).toBe("5000");
  });

  it("set then get round-trips boolean strings", () => {
    setToolConfig("mytool", "enabled", "true");
    expect(getToolConfig("mytool", "enabled")).toBe("true");
    setToolConfig("mytool", "enabled", "false");
    expect(getToolConfig("mytool", "enabled")).toBe("false");
  });

  it("updating a slot overwrites the previous value", () => {
    setToolConfig("mytool", "base_url", "https://old.example.com");
    setToolConfig("mytool", "base_url", "https://new.example.com");
    expect(getToolConfig("mytool", "base_url")).toBe("https://new.example.com");
  });

  it("deleteToolConfig removes the entry and returns true", () => {
    setToolConfig("mytool", "base_url", "https://api.example.com");
    expect(deleteToolConfig("mytool", "base_url")).toBe(true);
    expect(getToolConfig("mytool", "base_url")).toBeNull();
  });

  it("deleteToolConfig on a missing entry returns false", () => {
    expect(deleteToolConfig("mytool", "nonexistent")).toBe(false);
  });

  it("slots are scoped per tool — different tools do not share values", () => {
    setToolConfig("tool-a", "api_key", "key-for-a");
    expect(getToolConfig("tool-b", "api_key")).toBeNull();
    deleteToolConfig("tool-a", "api_key");
  });

  it("invalid tool name (spaces) returns null without throwing", () => {
    expect(getToolConfig("bad name", "key")).toBeNull();
  });

  it("invalid key (spaces) returns null without throwing", () => {
    expect(getToolConfig("mytool", "bad key")).toBeNull();
  });

  it("setToolConfig throws on invalid tool name", () => {
    expect(() => setToolConfig("bad name", "key", "v")).toThrow();
  });

  it("setToolConfig throws on invalid key", () => {
    expect(() => setToolConfig("mytool", "bad key", "v")).toThrow();
  });

  describe("describeToolConfig", () => {
    const slots = [
      { key: "base_url", type: "string" as const, required: true, label: "Base URL" },
      { key: "timeout_ms", type: "number" as const, required: false, label: "Timeout" },
      { key: "verify", type: "boolean" as const, required: false },
    ];

    it("returns null value for all slots when nothing is set", () => {
      const desc = describeToolConfig("emptytool", slots);
      expect(desc).toHaveLength(3);
      for (const d of desc) expect(d.value).toBeNull();
    });

    it("returns the persisted value alongside slot metadata", () => {
      setToolConfig("emptytool", "base_url", "https://api.example.com");
      const desc = describeToolConfig("emptytool", slots);
      const urlSlot = desc.find((d) => d.key === "base_url")!;
      expect(urlSlot.value).toBe("https://api.example.com");
      expect(urlSlot.required).toBe(true);
      expect(urlSlot.label).toBe("Base URL");
      deleteToolConfig("emptytool", "base_url");
    });

    it("returns null value for unset slots even when others are set", () => {
      setToolConfig("emptytool", "timeout_ms", "3000");
      const desc = describeToolConfig("emptytool", slots);
      expect(desc.find((d) => d.key === "timeout_ms")!.value).toBe("3000");
      expect(desc.find((d) => d.key === "base_url")!.value).toBeNull();
      deleteToolConfig("emptytool", "timeout_ms");
    });
  });
});
