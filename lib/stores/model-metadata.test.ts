import { afterEach, describe, expect, it } from "vitest";
import {
  clearModelMetadata,
  listModelMetadata,
  resolvedModelMetadata,
  saveModelMetadata,
} from "./model-metadata";

const provenance = {
  evidence: "GPT-6.2 Astra advertises provider-native web search.",
  source_url: "https://developers.openai.com/api/docs/models",
  checked_at: "2026-11-28T00:00:00.000Z",
};

afterEach(() => {
  clearModelMetadata();
});

describe("model metadata", () => {
  it("overlays a source-backed capability on the static heuristic", () => {
    saveModelMetadata([{
      provider: "openai",
      model_id: "gpt-6.2-astra",
      capabilities: { web_search: { value: true, ...provenance } },
    }]);

    expect(resolvedModelMetadata("openai", "gpt-6.2-astra").capabilities.web_search).toBe(true);
    expect(listModelMetadata("openai")).toHaveLength(1);
  });

  it("clears every persisted observation", () => {
    saveModelMetadata([{
      provider: "openai",
      model_id: "gpt-6.2-astra",
      capabilities: { web_search: { value: true, ...provenance } },
    }]);
    clearModelMetadata();
    expect(listModelMetadata()).toEqual([]);
  });
});
