// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LOCAL_EMBEDDING_CONFIG_NAME } from "@/lib/embeddings/constants";
import { EmbeddingModelSection } from "./EmbeddingModelSection";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(), save: vi.fn(), confirm: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  api: { documents: { getSettings: mocks.settings, setSettings: mocks.save } },
}));
vi.mock("@/lib/ui/confirm", () => ({ confirmAction: mocks.confirm }));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({ embedding_model_config: LOCAL_EMBEDDING_CONFIG_NAME });
  mocks.save.mockResolvedValue({ embedding_model_config: null });
  mocks.confirm.mockResolvedValue(false);
});

describe("external embedding provider warning", () => {
  it("does not switch or probe the provider when the warning is declined", async () => {
    render(<EmbeddingModelSection models={[]} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(LOCAL_EMBEDDING_CONFIG_NAME));
    fireEvent.change(select, { target: { value: "__auto__" } });
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(mocks.save).not.toHaveBeenCalled();
    expect(select.value).toBe(LOCAL_EMBEDDING_CONFIG_NAME);
  });

  it("saves a nonlocal selection only after confirmation", async () => {
    mocks.confirm.mockResolvedValue(true);
    render(<EmbeddingModelSection models={[]} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(LOCAL_EMBEDDING_CONFIG_NAME));
    fireEvent.change(select, { target: { value: "__auto__" } });
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ embedding_model_config: null }));
  });
});
