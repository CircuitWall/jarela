import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-tool-secrets-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { deleteToolSecret, describeToolSecrets, getToolSecret, setToolSecret } =
  await import("./tool-secrets");

afterEach(() => {
  deleteToolSecret("synthetic-tool", "api_key");
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe("external tool secret descriptions", () => {
  it("reports set state without returning the stored value", () => {
    setToolSecret("synthetic-tool", "api_key", "plaintext-secret");
    expect(getToolSecret("synthetic-tool", "api_key")).toBe("plaintext-secret");

    const described = describeToolSecrets("synthetic-tool", [
      { key: "api_key", label: "API key", required: true },
      { key: "other", label: "Other" },
    ]);
    expect(described).toEqual([
      { key: "api_key", label: "API key", required: true, is_set: true },
      { key: "other", label: "Other", is_set: false },
    ]);
    expect(JSON.stringify(described)).not.toContain("plaintext-secret");
  });

  it("does not read secrets for invalid tool names", () => {
    expect(describeToolSecrets("../bad", [{ key: "api_key" }])).toEqual([
      { key: "api_key", is_set: false },
    ]);
  });
});
