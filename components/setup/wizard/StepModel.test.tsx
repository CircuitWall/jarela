// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ModelConfig } from "@/api/types";
import { StepModel } from "./StepModel";

vi.mock("@/components/models/ModelEditor", () => ({
  ModelEditor: ({ initialProvider, autoLoadCatalog }: { initialProvider?: string; autoLoadCatalog?: boolean }) => (
    <div data-testid="model-editor" data-provider={initialProvider ?? "none"} data-auto-load={String(autoLoadCatalog)} />
  ),
}));
vi.mock("@/components/models/ProviderLogo", () => ({ ProviderLogo: () => null }));

const existingModel = {
  name: "saved",
  provider: "openai",
  model_id: "gpt-test",
  is_default: true,
} as ModelConfig;

it("opens the first model editor with the sole configured provider and catalog loading", async () => {
  render(<StepModel models={[]} onChanged={vi.fn()} defaultProvider="openai" />);

  const editor = await screen.findByTestId("model-editor");
  expect(editor.getAttribute("data-provider")).toBe("openai");
  expect(editor.getAttribute("data-auto-load")).toBe("true");
});

it.each([
  { models: [] as ModelConfig[], defaultProvider: undefined, readOnly: false },
  { models: [] as ModelConfig[], defaultProvider: undefined, readOnly: true },
  { models: [existingModel], defaultProvider: "openai", readOnly: false },
])("does not auto-open without a sole provider and an empty writable model list", async ({ models, defaultProvider, readOnly }) => {
  render(<StepModel models={models} onChanged={vi.fn()} defaultProvider={defaultProvider} readOnly={readOnly} />);

  await waitFor(() => expect(screen.queryByTestId("model-editor")).toBeNull());
});

it("offers an enabled model when all saved models are disabled", () => {
  render(<StepModel models={[{ ...existingModel, enabled: false }]} onChanged={vi.fn()} />);

  expect(screen.getByRole("button", { name: /Add an enabled model/ })).toBeTruthy();
  expect(screen.getByText(/saved models are disabled/i)).toBeTruthy();
});
