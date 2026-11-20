// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { CatalogModel } from "@/api/types";
import { applyCatalogPick } from "./ModelIdSection";
import type { ModelEditorForm } from "./useModelEditorForm";

function formStub(overrides: Partial<ModelEditorForm> = {}): ModelEditorForm {
  return {
    modelId: "",
    nameTouched: false,
    isEdit: false,
    setName: vi.fn(),
    setModelId: vi.fn(),
    setMaxTokens: vi.fn(),
    setAutoMaxTokens: vi.fn(),
    setContextWindowTokens: vi.fn(),
    setAutoContextWindowTokens: vi.fn(),
    setShowCatalog: vi.fn(),
    ...overrides,
  } as unknown as ModelEditorForm;
}

const model = {
  id: "deepseek-flash",
  context_length: 1_048_576,
  max_output_tokens: 393_216,
  hosted_on: "deepseek",
  capabilities: { vision: true, tools: true, streaming: true, json_mode: true, web_search: false, audio: false, files: false },
} as CatalogModel;

describe("applyCatalogPick", () => {
  it("suggests the catalog's limits without writing them into the saved params", () => {
    const form = formStub();
    applyCatalogPick(model, form);

    expect(form.setModelId).toHaveBeenCalledWith("deepseek-flash");
    expect(form.setAutoContextWindowTokens).toHaveBeenCalledWith("1048576");
    expect(form.setAutoMaxTokens).toHaveBeenCalledWith("393216");
    // The values a pick used to stamp are what froze old configs at 8k tokens.
    expect(form.setContextWindowTokens).not.toHaveBeenCalled();
    expect(form.setMaxTokens).not.toHaveBeenCalled();
    expect(form.setShowCatalog).toHaveBeenCalledWith(false);
  });

  it("clears a previous suggestion when the picked model reports no limits", () => {
    const form = formStub();
    applyCatalogPick({ ...model, context_length: null, max_output_tokens: null } as CatalogModel, form);

    expect(form.setAutoContextWindowTokens).toHaveBeenCalledWith(null);
    expect(form.setAutoMaxTokens).toHaveBeenCalledWith(null);
    expect(form.setMaxTokens).not.toHaveBeenCalled();
  });
});
