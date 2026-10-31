// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelsPanel } from "./ModelsPanel";

const mocks = vi.hoisted(() => ({
  create: vi.fn(), update: vi.fn(), setDefault: vi.fn(), setEnabled: vi.fn(),
  remove: vi.fn(), refresh: vi.fn(), refreshConfig: vi.fn(), confirm: vi.fn(),
}));
vi.mock("@/hooks/useModels", () => ({
  useModels: () => ({
    models: [{ name: "synthetic-model", provider: "openai", model_id: "synthetic-v1", enabled: true }],
    assignments: [{ model_config_name: "synthetic-model", agent_id: "synthetic-agent" }],
    loading: false, ...mocks,
  }),
}));
vi.mock("@/hooks/useAgents", () => ({
  useAgents: () => ({ agents: [{ id: "synthetic-agent", name: "Synthetic listener" }], loading: false }),
}));
vi.mock("@/hooks/useDeepLinkScroll", () => ({ useDeepLinkScroll: vi.fn() }));
vi.mock("@/api/runtime-config", () => ({ refreshRuntimeConfig: mocks.refreshConfig }));
vi.mock("@/lib/ui/confirm", () => ({ confirmAction: mocks.confirm }));
vi.mock("./ModelEditor", () => ({ ModelEditor: () => <div>Editing synthetic model</div> }));
vi.mock("./CustomProvidersSection", () => ({ CustomProvidersSection: () => null }));
vi.mock("./EmbeddingModelSection", () => ({ EmbeddingModelSection: () => null }));
vi.mock("./CapBadges", () => ({ CapBadges: () => null }));
vi.mock("./ProviderLogo", () => ({ ProviderLogo: () => null }));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirm.mockResolvedValue(false);
  fetchMock = vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ entries: [
      { name: "JARELA_MODEL_ROUTER_MODE", current: "off" },
      { name: "JARELA_MODEL_ROUTER_POLICY", current: "balanced" },
      { name: "JARELA_USAGE_STRATEGY", current: "balanced" },
    ] }),
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

it("saves coupled strategy settings atomically and rolls back both on failure", async () => {
  render(<ModelsPanel />);
  const strategy = screen.getByRole("combobox", { name: "Global model strategy" });
  await waitFor(() => expect(strategy).toHaveProperty("disabled", false));
  fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "Synthetic strategy failure" }) });
  fireEvent.change(strategy, { target: { value: "high_reasoning" } });
  expect(await screen.findByText("Synthetic strategy failure")).toBeTruthy();
  expect(strategy).toHaveProperty("value", "balanced");
  expect(fetchMock).toHaveBeenLastCalledWith("/api/v1/env", expect.objectContaining({
    method: "PATCH",
    body: JSON.stringify({ updates: [
      { name: "JARELA_USAGE_STRATEGY", value: "high_reasoning" },
      { name: "JARELA_MODEL_ROUTER_POLICY", value: "quality" },
    ] }),
  }));
  expect(mocks.refreshConfig).not.toHaveBeenCalled();
  fireEvent.change(strategy, { target: { value: "fast" } });
  await waitFor(() => expect(mocks.refreshConfig).toHaveBeenCalledOnce());
  expect(strategy).toHaveProperty("value", "fast");
  expect(screen.getByRole("combobox", { name: "Balanced strategy router mode" })).toHaveProperty("disabled", true);
});

it("rolls back optimistic router mode after a failed PATCH", async () => {
  render(<ModelsPanel />);
  const mode = screen.getByRole("combobox", { name: "Balanced strategy router mode" });
  await waitFor(() => expect(mode).toHaveProperty("disabled", false));
  fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Synthetic router failure" }) });
  fireEvent.change(mode, { target: { value: "heuristic" } });
  expect(await screen.findByText("Synthetic router failure")).toBeTruthy();
  expect(mode).toHaveProperty("value", "off");
  expect(fetchMock).toHaveBeenLastCalledWith("/api/v1/env", expect.objectContaining({
    body: JSON.stringify({ name: "JARELA_MODEL_ROUTER_MODE", value: "heuristic" }),
  }));
});

it("keeps row action clicks separate from opening the model editor", async () => {
  render(<ModelsPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Set as default" }));
  await waitFor(() => expect(mocks.setDefault).toHaveBeenCalledWith("synthetic-model"));
  fireEvent.click(screen.getByRole("button", { name: "Disable synthetic-model" }));
  await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith("synthetic-model", false));
  fireEvent.click(screen.getByRole("button", { name: /Delete; assigned agents/ }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({
    message: expect.stringContaining("Synthetic listener will use automatic model selection"),
  })));
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(screen.queryByText("Editing synthetic model")).toBeNull();
  fireEvent.click(screen.getByText("synthetic-model"));
  expect(screen.getByText("Editing synthetic model")).toBeTruthy();
});
