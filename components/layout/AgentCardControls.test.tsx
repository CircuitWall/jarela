// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCardControls, type AgentCardSettings } from "./AgentCardControls";

const mocks = vi.hoisted(() => ({
  listModels: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock("@/api/client", () => ({ api: { models: { list: mocks.listModels } } }));
vi.mock("@/lib/ui/error-report", () => ({ pushErrorToast: mocks.reportError }));

const models = [
  { name: "Synthetic fast", provider: "mock", model_id: "fast", enabled: true },
  { name: "Synthetic reasoning", provider: "mock", model_id: "reasoning" },
  { name: "Synthetic disabled", provider: "mock", model_id: "disabled", enabled: false },
];
const agent: AgentCardSettings = {
  id: "synthetic-agent", model_config_name: "Synthetic fast",
  usage_strategy: "balanced", voice_enabled: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listModels.mockResolvedValue(models);
});

async function ready() {
  await waitFor(() => expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Model" }).disabled).toBe(false));
}

describe("AgentCardControls", () => {
  it("shows current settings, enabled model configs, and automatic routing", async () => {
    render(<AgentCardControls agent={agent} isFullMode onUpdate={vi.fn()} />);
    await ready();
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Model" }).value).toBe("Synthetic fast");
    expect(screen.getByRole<HTMLOptionElement>("option", { name: /Synthetic reasoning/ }).disabled).toBe(false);
    expect(screen.queryByRole("option", { name: /Synthetic disabled/ })).toBeNull();
    expect(screen.getByRole("option", { name: "Automatic routing" })).toBeTruthy();
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Usage strategy" }).value).toBe("balanced");
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Enable voice" }).checked).toBe(false);
    expect(screen.getByText(/do not restart a running reply/)).toBeTruthy();
  });

  it.each([
    ["Model", "Synthetic reasoning", { model_config_name: "Synthetic reasoning" }],
    ["Model", "", { model_config_name: null }],
    ["Usage strategy", "high_reasoning", { usage_strategy: "high_reasoning" }],
    ["Usage strategy", "", { usage_strategy: null }],
  ])("saves only the changed %s setting (%s)", async (label, value, patch) => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(<AgentCardControls agent={agent} isFullMode onUpdate={onUpdate} />);
    await ready();
    fireEvent.change(screen.getByRole("combobox", { name: label }), { target: { value } });
    await waitFor(() => expect(screen.getByText("Agent settings saved.")).toBeTruthy());
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith(agent.id, patch);
  });

  it("saves voice enablement without changing models, instructions, or other voice settings", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(<AgentCardControls agent={agent} isFullMode onUpdate={onUpdate} />);
    await ready();
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable voice" }));
    await waitFor(() => expect(screen.getByText("Agent settings saved.")).toBeTruthy());
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith(agent.id, { voice_enabled: true });
    expect(screen.getByText(/Voice requires a configured Google AI integration/)).toBeTruthy();
  });

  it("prevents overlapping saves while displaying the pending selection without claiming success", async () => {
    let finish!: () => void;
    const onUpdate = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<AgentCardControls agent={agent} isFullMode onUpdate={onUpdate} />);
    await ready();
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Model" });
    fireEvent.change(select, { target: { value: "Synthetic reasoning" } });
    expect(screen.getByRole<HTMLFieldSetElement>("group").disabled).toBe(true);
    expect(select.value).toBe("Synthetic reasoning");
    expect(screen.getByText("Saving agent settings...")).toBeTruthy();
    fireEvent.change(select, { target: { value: "" } });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(screen.getByRole<HTMLFieldSetElement>("group").disabled).toBe(false);
  });

  it("shows a pending voice toggle immediately and rolls it back on a failed save", async () => {
    let reject!: (reason: Error) => void;
    const onUpdate = vi.fn().mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    render(<AgentCardControls agent={agent} isFullMode onUpdate={onUpdate} />);
    await ready();
    const voice = screen.getByRole<HTMLInputElement>("checkbox", { name: "Enable voice" });
    fireEvent.click(voice);
    expect(voice.checked).toBe(true);
    expect(screen.queryByText("Agent settings saved.")).toBeNull();
    await act(async () => reject(new Error("Synthetic toggle failure")));
    expect(voice.checked).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("Synthetic toggle failure");
  });

  it("reports save failures, retains saved values, and permits a retry", async () => {
    const failure = new Error("Synthetic save failure");
    const onUpdate = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    render(<AgentCardControls agent={agent} isFullMode onUpdate={onUpdate} />);
    await ready();
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Model" });
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Synthetic save failure"));
    expect(select.value).toBe("Synthetic fast");
    expect(screen.queryByText("Agent settings saved.")).toBeNull();
    expect(mocks.reportError).toHaveBeenCalledWith(expect.objectContaining({
      error: failure, context: expect.objectContaining({ agent_id: agent.id }),
    }));
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("Agent settings saved.")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["Synthetic disabled", "Removed model"])("preserves an unavailable saved override: %s", async (name) => {
    render(<AgentCardControls agent={{ ...agent, model_config_name: name }} isFullMode onUpdate={vi.fn()} />);
    await ready();
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Model" }).value).toBe(name);
    expect(screen.getByRole<HTMLOptionElement>("option", { name: new RegExp(name) }).disabled).toBe(true);
    expect(screen.getByText(/saved model override is unavailable/)).toBeTruthy();
  });

  it("reports model loading failures with a working retry and responds to model changes", async () => {
    mocks.listModels.mockRejectedValueOnce(new Error("Synthetic list failure")).mockResolvedValue(models);
    render(<AgentCardControls agent={agent} isFullMode onUpdate={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Synthetic list failure"));
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Model" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry loading models" }));
    await ready();
    mocks.listModels.mockResolvedValue([models[0]]);
    act(() => { window.dispatchEvent(new Event("jarela:models-changed")); });
    await waitFor(() => expect(screen.queryByRole("option", { name: /Synthetic reasoning/ })).toBeNull());
  });

  it("handles an empty model list and hides advanced strategy in Essential mode", async () => {
    mocks.listModels.mockResolvedValue([]);
    render(<AgentCardControls agent={{ ...agent, model_config_name: null }} isFullMode={false} onUpdate={vi.fn()} />);
    await ready();
    expect(screen.getByText(/No enabled models/)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Usage strategy" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Enable voice" })).toBeTruthy();
  });

  it("keeps an in-flight save bound to the original agent when selection changes", async () => {
    let finish!: () => void;
    const onUpdate = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { rerender } = render(<AgentCardControls key={agent.id} agent={agent} isFullMode onUpdate={onUpdate} />);
    await ready();
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "" } });
    const other = { ...agent, id: "other", model_config_name: "Synthetic reasoning", voice_enabled: true };
    rerender(<AgentCardControls key={other.id} agent={other} isFullMode onUpdate={onUpdate} />);
    await ready();
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Model" }).value).toBe("Synthetic reasoning");
    expect(screen.queryByText("Saving agent settings...")).toBeNull();
    await act(async () => finish());
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith(agent.id, { model_config_name: null });
    expect(screen.queryByText("Agent settings saved.")).toBeNull();
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Enable voice" }).checked).toBe(true);
  });
});
