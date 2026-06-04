import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModelEditorPayload, type ModelEditorFormInput } from "./editor-payload";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-editor-payload-"));
process.env.JARELA_DB_DIR = tmpRoot;

// Imported lazily so the JARELA_DB_DIR override above is in place before
// the SQLite connection initialises.
const { upsertModelConfig, getModelConfig, getModelParams, deleteModelConfig } =
  await import("@/lib/stores/model-config");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function baseInput(overrides: Partial<ModelEditorFormInput> = {}): ModelEditorFormInput {
  return {
    name: "test-claude",
    provider: "anthropic",
    model_id: "claude-sonnet-4-6",
    api_key: "sk-test-key",
    base_url: "",
    extra_headers: "",
    temperature: "",
    max_tokens: "",
    context_window_tokens: "",
    is_default: false,
    ...overrides,
  };
}

describe("buildModelEditorPayload — required fields", () => {
  it("rejects empty name", () => {
    const r = buildModelEditorPayload(baseInput({ name: "  " }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Name and model ID are required/);
  });

  it("rejects empty model_id", () => {
    const r = buildModelEditorPayload(baseInput({ model_id: "" }));
    expect(r.ok).toBe(false);
  });

  it("trims whitespace off name and model_id", () => {
    const r = buildModelEditorPayload(baseInput({ name: "  spaced  ", model_id: "  m-1  " }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe("spaced");
      expect(r.payload.model_id).toBe("m-1");
    }
  });
});

describe("buildModelEditorPayload — params shaping", () => {
  it("only emits fields the user actually filled in", () => {
    const r = buildModelEditorPayload(baseInput({ api_key: "" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.params).toEqual({});
    }
  });

  it("includes api_key, base_url, temperature, max_tokens when provided", () => {
    const r = buildModelEditorPayload(baseInput({
      api_key: "sk-abc",
      base_url: "https://example.test/v1",
      temperature: "0.4",
      max_tokens: "2048",
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.params).toEqual({
        api_key: "sk-abc",
        base_url: "https://example.test/v1",
        temperature: 0.4,
        max_tokens: 2048,
      });
    }
  });

  it("floors context_window_tokens to an integer and rejects <= 0", () => {
    const positive = buildModelEditorPayload(baseInput({ context_window_tokens: "32768.9" }));
    expect(positive.ok).toBe(true);
    if (positive.ok) expect(positive.payload.params.context_window_tokens).toBe(32768);

    const zero = buildModelEditorPayload(baseInput({ context_window_tokens: "0" }));
    expect(zero.ok).toBe(true);
    if (zero.ok) expect(zero.payload.params.context_window_tokens).toBeUndefined();
  });

  it("does NOT emit context_tier_proportions or context_tier_priority", () => {
    // Regression guard: the editor's per-model tier UI was removed; the
    // helper must not accidentally re-introduce those keys with defaults.
    const r = buildModelEditorPayload(baseInput({
      api_key: "sk-x",
      max_tokens: "1024",
      context_window_tokens: "8192",
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.params).not.toHaveProperty("context_tier_proportions");
      expect(r.payload.params).not.toHaveProperty("context_tier_priority");
    }
  });

  it("ignores blank numeric inputs (treats them as undefined)", () => {
    const r = buildModelEditorPayload(baseInput({
      temperature: "  ",
      max_tokens: "",
      context_window_tokens: "",
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.params).not.toHaveProperty("temperature");
      expect(r.payload.params).not.toHaveProperty("max_tokens");
      expect(r.payload.params).not.toHaveProperty("context_window_tokens");
    }
  });

  it("ignores non-numeric numeric fields rather than throwing", () => {
    const r = buildModelEditorPayload(baseInput({ temperature: "not-a-number" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.params).not.toHaveProperty("temperature");
  });
});

describe("buildModelEditorPayload — extra_headers JSON", () => {
  it("parses a valid JSON object", () => {
    const r = buildModelEditorPayload(baseInput({ extra_headers: '{"X-Trace": "abc"}' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.params.extra_headers).toEqual({ "X-Trace": "abc" });
  });

  it("rejects malformed JSON", () => {
    const r = buildModelEditorPayload(baseInput({ extra_headers: "{not json" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/valid JSON/);
  });

  it("rejects a JSON array masquerading as headers", () => {
    const r = buildModelEditorPayload(baseInput({ extra_headers: '["X-Trace", "abc"]' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON object/);
  });

  it("treats blank header text as no headers", () => {
    const r = buildModelEditorPayload(baseInput({ extra_headers: "   " }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.params).not.toHaveProperty("extra_headers");
  });
});

describe("buildModelEditorPayload — round-trip yields a usable model", () => {
  // Lightweight integration: feed the helper's output into the same store
  // the API route writes to, then read it back the way prepareThreadRun
  // and the dashboard read it. This is the "model is actually usable"
  // smoke check the user asked for — it would catch a payload that the
  // schema accepts on insert but that getModelParams cannot decode, or a
  // params shape the rest of the app doesn't expect.
  it("stores, retrieves, and round-trips a full editor payload", () => {
    const r = buildModelEditorPayload(baseInput({
      name: "smoke-claude",
      api_key: "sk-smoke",
      max_tokens: "4096",
      context_window_tokens: "200000",
      temperature: "0.7",
      is_default: true,
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const inserted = upsertModelConfig(
      r.name,
      r.payload.provider,
      r.payload.model_id,
      r.payload.params,
      r.payload.is_default,
    );
    expect(inserted.name).toBe("smoke-claude");
    expect(inserted.is_default).toBe(1);

    const fetched = getModelConfig("smoke-claude");
    expect(fetched).not.toBeNull();
    expect(fetched!.provider).toBe("anthropic");
    expect(fetched!.model_id).toBe("claude-sonnet-4-6");

    const decoded = getModelParams(fetched);
    expect(decoded).toMatchObject({
      api_key: "sk-smoke",
      max_tokens: 4096,
      temperature: 0.7,
      context_window_tokens: 200000,
    });
    // The two removed-from-UI keys must NOT appear after a full round-trip.
    expect(decoded).not.toHaveProperty("context_tier_proportions");
    expect(decoded).not.toHaveProperty("context_tier_priority");

    deleteModelConfig("smoke-claude");
    expect(getModelConfig("smoke-claude")).toBeNull();
  });

  it("a minimal config (just name + provider + model_id) is still usable", () => {
    const r = buildModelEditorPayload(baseInput({ name: "bare-min", api_key: "" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    upsertModelConfig(r.name, r.payload.provider, r.payload.model_id, r.payload.params, r.payload.is_default);
    const fetched = getModelConfig("bare-min");
    expect(fetched).not.toBeNull();
    expect(getModelParams(fetched)).toEqual({});

    deleteModelConfig("bare-min");
  });
});
