import { describe, expect, it } from "vitest";
import { computeFeatureReadiness } from "./feature-readiness";
import type { IntegrationStatus, ModelConfig } from "@/api/types";

function model(provider: string, model_id: string): ModelConfig {
  return {
    name: model_id,
    provider,
    model_id,
    params: {},
    is_default: false,
    created_at: "1970-01-01T00:00:00Z",
    updated_at: "1970-01-01T00:00:00Z",
  };
}

function integration(name: string, configured: boolean): IntegrationStatus {
  return {
    name,
    configured,
    values: {},
    updated_at: configured ? "1970-01-01T00:00:00Z" : null,
  };
}

describe("computeFeatureReadiness", () => {
  it("reports nothing ready with empty inputs", () => {
    const r = computeFeatureReadiness({ models: [] });
    expect(r.selectedModelCaps).toBeNull();
    expect(r.hasGoogleIntegration).toBe(false);
    expect(r.hasGeminiModel).toBe(false);
    expect(r.hasEmbeddingsModel).toBe(false);
    expect(r.voiceReady).toBe(false);
    expect(r.documentsReady).toBe(false);
  });

  it("detects gemini model presence by registered model", () => {
    const r = computeFeatureReadiness({
      models: [model("gemini", "gemini-2.0-flash")],
    });
    expect(r.hasGeminiModel).toBe(true);
  });

  it("detects gemini model presence by selection alone", () => {
    const r = computeFeatureReadiness({
      models: [],
      selectedProvider: "gemini",
      selectedModelId: "gemini-2.0-flash",
    });
    expect(r.hasGeminiModel).toBe(true);
    expect(r.selectedModelCaps).not.toBeNull();
  });

  it("marks voice ready only when google integration + gemini model both present", () => {
    const r = computeFeatureReadiness({
      models: [model("gemini", "gemini-2.0-flash")],
      integrations: [integration("google", true)],
    });
    expect(r.voiceReady).toBe(true);

    const notReady = computeFeatureReadiness({
      models: [model("gemini", "gemini-2.0-flash")],
      integrations: [integration("google", false)],
    });
    expect(notReady.voiceReady).toBe(false);
  });

  it("marks documents ready when an embeddings-capable provider is registered", () => {
    const r = computeFeatureReadiness({
      models: [model("openai", "gpt-4o")],
    });
    expect(r.hasEmbeddingsModel).toBe(true);
    expect(r.documentsReady).toBe(true);
  });

  it("does not mark documents ready for non-embeddings providers", () => {
    const r = computeFeatureReadiness({
      models: [model("anthropic", "claude-3-5-sonnet")],
    });
    expect(r.hasEmbeddingsModel).toBe(false);
    expect(r.documentsReady).toBe(false);
  });

  it("detects embeddings via selected provider when no models registered", () => {
    const r = computeFeatureReadiness({
      models: [],
      selectedProvider: "openai",
      selectedModelId: "gpt-4o",
    });
    expect(r.hasEmbeddingsModel).toBe(true);
  });
});
