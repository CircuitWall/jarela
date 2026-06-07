import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-credentials-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  createCredential,
  deleteCredential,
  getCredential,
  getCredentialParams,
  listCredentials,
  nextCredentialId,
  updateCredential,
} = await import("./credentials");
const { upsertModelConfig, getModelConfig, getModelParams } = await import("./model-config");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("credentials store", () => {
  it("allocates a non-colliding id on bare type+provider", () => {
    const a = createCredential({ type: "model", provider: "anthropic", params: { api_key: "sk-1" } });
    const b = createCredential({ type: "model", provider: "anthropic", params: { api_key: "sk-2" } });
    expect(a.id).toBe("model-anthropic");
    expect(b.id).toBe("model-anthropic-2");

    expect(nextCredentialId("model", "anthropic")).toBe("model-anthropic-3");
  });

  it("round-trips params through encryption", () => {
    const c = createCredential({
      type: "model", provider: "openai",
      params: { api_key: "sk-secret", base_url: "https://example", extra_headers: { "x-key": "y" } },
    });
    const fetched = getCredential(c.id);
    expect(fetched).not.toBeNull();
    expect(getCredentialParams(fetched!)).toEqual({
      api_key: "sk-secret",
      base_url: "https://example",
      extra_headers: { "x-key": "y" },
    });
  });

  it("updateCredential merges only provided fields", () => {
    const c = createCredential({
      type: "model", provider: "cohere",
      params: { api_key: "old", base_url: "https://a" },
    });
    const updated = updateCredential(c.id, { params: { api_key: "new", base_url: "https://a" } });
    expect(getCredentialParams(updated!).api_key).toBe("new");
    expect(getCredentialParams(updated!).base_url).toBe("https://a");
  });

  it("listCredentials filters by type and provider", () => {
    createCredential({ type: "tts", provider: "gemini", params: { api_key: "tts-1" } });
    const ttsOnly = listCredentials({ type: "tts" });
    expect(ttsOnly.every((r) => r.type === "tts")).toBe(true);
    const geminiOnly = listCredentials({ provider: "gemini" });
    expect(geminiOnly.every((r) => r.provider === "gemini")).toBe(true);
  });

  it("deleteCredential removes the row", () => {
    const c = createCredential({ type: "model", provider: "deepseek", params: { api_key: "x" } });
    expect(deleteCredential(c.id)).toBe(true);
    expect(getCredential(c.id)).toBeNull();
  });

  it("getModelParams merges credential params under inline params", () => {
    const cred = createCredential({
      type: "model", provider: "anthropic",
      params: { api_key: "from-cred", base_url: "https://cred", temperature: 0.1 },
    });
    upsertModelConfig(
      "merge-test", "anthropic", "claude-x",
      { temperature: 0.9 },
      false,
      cred.id,
    );
    const cfg = getModelConfig("merge-test")!;
    const resolved = getModelParams(cfg);
    expect(resolved.api_key).toBe("from-cred");
    expect(resolved.base_url).toBe("https://cred");
    // Inline params win on key collisions.
    expect(resolved.temperature).toBe(0.9);
  });
});
