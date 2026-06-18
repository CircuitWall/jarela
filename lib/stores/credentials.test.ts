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
  getDefaultCredential,
  listCredentials,
  nextCredentialId,
  setDefaultCredential,
  updateCredential,
} = await import("./credentials");
const { SECRET_PARAM_KEYS } = await import("./credentials");
const { INTEGRATIONS } = await import("./integrations");
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

  // Regression: `GET /api/v1/credentials` redacts param keys present in
  // SECRET_PARAM_KEYS. If a new integration manifest adds a secret
  // field whose key isn't on that list, the API returns the plaintext
  // (this leaked the github `token` field in v1.1.x before the fix).
  // Lock the contract so adding a new integration with a secret name
  // we don't recognise fails CI instead of silently leaking on prod.
  it("SECRET_PARAM_KEYS covers every secret field declared by integration manifests", () => {
    const missing: { integration: string; key: string }[] = [];
    for (const [name, meta] of Object.entries(INTEGRATIONS) as [string, { fields: readonly { key: string; secret: boolean }[] }][]) {
      for (const field of meta.fields) {
        if (field.secret && !SECRET_PARAM_KEYS.has(field.key)) {
          missing.push({ integration: name, key: field.key });
        }
      }
    }
    expect(missing, `Add these to SECRET_PARAM_KEYS in lib/stores/credentials.ts: ${JSON.stringify(missing)}`).toEqual([]);
  });
});

describe("credentials store: multi-instance label + is_default", () => {
  // First row of a (type, provider) pair must auto-label to "Default"
  // so the panel — which renders only configured rows by their name —
  // never shows a blank entry for the legacy single-credential install.
  it("auto-labels the first row of a (type, provider) pair 'Default'", () => {
    const a = createCredential({ type: "model", provider: "labels-first", params: { api_key: "k1" } });
    expect(a.label).toBe("Default");
    expect(a.is_default).toBe(1);
  });

  it("leaves label null on subsequent rows of the same pair when caller didn't supply one", () => {
    createCredential({ type: "model", provider: "labels-second", params: { api_key: "k1" } });
    const b = createCredential({ type: "model", provider: "labels-second", params: { api_key: "k2" } });
    expect(b.label).toBeNull();
    expect(b.is_default).toBe(0);
  });

  it("honours caller-supplied label on first row instead of overriding with 'Default'", () => {
    const c = createCredential({
      type: "model", provider: "labels-explicit",
      label: "Work",
      params: { api_key: "k1" },
    });
    expect(c.label).toBe("Work");
    expect(c.is_default).toBe(1);
  });

  it("trims blank/whitespace labels to null", () => {
    // Forcing label="" on a second row hits the normaliseLabel branch
    // without colliding with the auto-Default for the first row.
    createCredential({ type: "model", provider: "labels-blank", params: { api_key: "k1" } });
    const b = createCredential({
      type: "model", provider: "labels-blank",
      label: "   ",
      params: { api_key: "k2" },
    });
    expect(b.label).toBeNull();
  });

  it("setDefaultCredential promotes the target row and clears the previous default", () => {
    const a = createCredential({ type: "model", provider: "default-promote", params: { api_key: "k1" } });
    const b = createCredential({ type: "model", provider: "default-promote", label: "Other", params: { api_key: "k2" } });
    expect(a.is_default).toBe(1);
    expect(b.is_default).toBe(0);

    const promoted = setDefaultCredential(b.id);
    expect(promoted?.is_default).toBe(1);
    expect(getCredential(a.id)?.is_default).toBe(0);
  });

  it("setDefaultCredential returns null for unknown ids and leaves siblings untouched", () => {
    const a = createCredential({ type: "model", provider: "default-missing", params: { api_key: "k1" } });
    expect(setDefaultCredential("nonexistent-id")).toBeNull();
    expect(getCredential(a.id)?.is_default).toBe(1);
  });

  it("getDefaultCredential returns the row currently flagged is_default=1", () => {
    const a = createCredential({ type: "model", provider: "default-resolve", params: { api_key: "k1" } });
    const b = createCredential({ type: "model", provider: "default-resolve", label: "Two", params: { api_key: "k2" } });
    expect(getDefaultCredential("model", "default-resolve")?.id).toBe(a.id);
    setDefaultCredential(b.id);
    expect(getDefaultCredential("model", "default-resolve")?.id).toBe(b.id);
  });

  it("getDefaultCredential returns null when no rows exist for the pair", () => {
    expect(getDefaultCredential("model", "no-such-provider")).toBeNull();
  });

  it("deleting the default promotes the surviving sibling so callers without an id keep resolving", () => {
    const a = createCredential({ type: "model", provider: "default-delete", params: { api_key: "k1" } });
    const b = createCredential({ type: "model", provider: "default-delete", label: "Other", params: { api_key: "k2" } });
    expect(a.is_default).toBe(1);
    expect(b.is_default).toBe(0);

    expect(deleteCredential(a.id)).toBe(true);
    // The lone survivor should now resolve as the default.
    expect(getDefaultCredential("model", "default-delete")?.id).toBe(b.id);
    expect(getCredential(b.id)?.is_default).toBe(1);
  });

  it("listCredentials orders is_default rows first within a (type, provider) pair", () => {
    const a = createCredential({ type: "model", provider: "list-order", params: { api_key: "k1" } });
    const b = createCredential({ type: "model", provider: "list-order", label: "Promoted", params: { api_key: "k2" } });
    setDefaultCredential(b.id);
    const rows = listCredentials({ type: "model", provider: "list-order" });
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
  });
});
