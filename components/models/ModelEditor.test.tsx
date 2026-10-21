// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ModelEditor } from "./ModelEditor";

const modelEditorMocks = vi.hoisted(() => ({ loadCatalog: vi.fn() }));

vi.mock("@/hooks/useDismissGuard", () => ({
  useDirty: () => false,
  useDismissGuard: ({ onClose }: { onClose: () => void }) => onClose,
}));
vi.mock("./model-editor/useModelEditorForm", () => ({
  useModelEditorForm: (_model: unknown, initialProvider?: string) => ({
    isEdit: false,
    model: undefined,
    name: "",
    provider: initialProvider ?? "anthropic",
    modelId: "",
    apiKey: "",
    baseUrl: "",
    extraHeaders: "",
    temperature: "",
    maxTokens: "",
    contextWindowTokens: "",
    isDefault: false,
    saving: false,
  }),
}));
vi.mock("./model-editor/useModelSaveHandlers", () => ({
  useModelSaveHandlers: () => ({
    loadCatalog: modelEditorMocks.loadCatalog,
    handleTestConnection: vi.fn(),
    handleSave: vi.fn(),
    confirmShrinkAndSave: vi.fn(),
    skipCompactAndSave: vi.fn(),
  }),
}));
vi.mock("./model-editor/EditorChrome", () => ({
  EditorChrome: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("./model-editor/ProbeAndFooter", () => ({ EditorFooter: () => null }));
vi.mock("./model-editor/ModelEditorBody", () => ({
  ModelEditorBody: ({ form }: { form: { provider: string } }) => <div>{form.provider}</div>,
  ModelEditorOverlays: () => null,
}));

it("loads the selected provider catalog once when requested by first-run setup", async () => {
  modelEditorMocks.loadCatalog.mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <ModelEditor
      initialProvider="openai"
      autoLoadCatalog
      onSave={vi.fn().mockResolvedValue(undefined)}
      onClose={onClose}
    />,
  );

  await waitFor(() => expect(modelEditorMocks.loadCatalog).toHaveBeenCalledOnce());
});
