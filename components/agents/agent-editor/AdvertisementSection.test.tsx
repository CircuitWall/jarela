// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "@/api/types";
import { AdvertisementSection } from "./AdvertisementSection";

const endpoint = "/api/v1/agent-advertisements";
const fetchMock = vi.fn();
const model: ModelConfig = {
  name: "Configured model", provider: "openai", model_id: "example",
  params: {}, enabled: true, is_default: true, created_at: "", updated_at: "",
};
const defaultPolicy = {
  enabled: false, model_config_name: null as string | null, max_calls_per_hour: 10,
  max_input_chars: 16_000, max_output_tokens: 1_024, timeout_ms: 30_000,
};
const enabledPolicy = { ...defaultPolicy, enabled: true, model_config_name: model.name };
const metadata = {
  purpose: "Summarize committed documents", call_when: ["A summary is needed"],
  do_not_call_for: ["Permission bypass"], inputs: "Document text", output: "A summary",
  tools: ["documents_search"],
};
function advertisement(status = "ready", extra = {}) {
  return {
    version: 1, generation_id: "generation-1", agent_id: "saved-agent", status,
    source_fingerprint: "source-digest", policy_fingerprint: "policy-digest",
    updated_at: "2026-10-30T12:00:00.000Z", error: null, enabled: true,
    advertisement: metadata, ...extra,
  };
}
function response(policy = defaultPolicy, record: ReturnType<typeof advertisement> | null = null) {
  return { ok: true, json: async () => ({ policy, advertisement: record }) };
}
function renderGlobal(models = [model]) {
  return render(<AdvertisementSection global models={models} />);
}
function renderAgent() {
  return render(<AdvertisementSection agentId="saved-agent" models={[model]} />);
}
function button(name: string) {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue(response());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AdvertisementSection", () => {
  it("keeps global policy settings in the shared panel and requires an explicit model", async () => {
    renderGlobal();
    await waitFor(() => expect(screen.getByLabelText("Enable advertisement generation globally").closest("fieldset")?.disabled).toBe(false));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(endpoint, expect.objectContaining({ method: "GET", cache: "no-store" }));
    expect((screen.getByLabelText("Enable advertisement generation globally") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("");

    fireEvent.click(screen.getByLabelText("Enable advertisement generation globally"));
    expect(button("Save generation settings").disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: model.name } });
    const savedPolicy = { ...enabledPolicy, max_input_chars: 12_000 };
    fireEvent.change(screen.getByLabelText("Maximum input characters"), { target: { value: "12000" } });
    fetchMock.mockResolvedValueOnce(response(savedPolicy));
    fireEvent.click(button("Save generation settings"));

    await waitFor(() => expect(screen.getByText("Global generation settings saved.")).toBeTruthy());
    expect(fetchMock).toHaveBeenLastCalledWith(endpoint, expect.objectContaining({
      method: "PUT", cache: "no-store",
      body: JSON.stringify({ policy: savedPolicy }),
    }));
  });

  it("rejects out-of-bound global input limits without saving", async () => {
    renderGlobal();
    await waitFor(() => expect(screen.getByLabelText("Maximum input characters").closest("fieldset")?.disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Maximum input characters"), { target: { value: "16001" } });
    expect(button("Save generation settings").disabled).toBe(true);
    expect(screen.getByText(/Maximum input characters must be a whole number/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(endpoint, expect.anything());
  });

  it("refreshes untouched global fields to the latest saved policy", async () => {
    fetchMock.mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({ ...defaultPolicy, max_input_chars: 12_000 }));
    renderGlobal();
    await waitFor(() => expect(button("Refresh global settings").disabled).toBe(false));
    fireEvent.click(button("Refresh global settings"));
    await waitFor(() => expect((screen.getByLabelText("Maximum input characters") as HTMLInputElement).value).toBe("12000"));
    expect(button("Save generation settings").disabled).toBe(true);
  });

  it("preserves unsaved global edits during a refresh", async () => {
    fetchMock.mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({ ...defaultPolicy, max_input_chars: 12_000 }));
    renderGlobal();
    await waitFor(() => expect(button("Refresh global settings").disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Maximum input characters"), { target: { value: "14000" } });
    fireEvent.click(button("Refresh global settings"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(button("Refresh global settings").disabled).toBe(false));
    expect((screen.getByLabelText("Maximum input characters") as HTMLInputElement).value).toBe("14000");
    expect(button("Save generation settings").disabled).toBe(false);
  });

  it("lets an individual agent be disabled without changing the global policy", async () => {
    const disabledRecord = advertisement("disabled", { enabled: false, advertisement: null });
    fetchMock.mockResolvedValueOnce(response(enabledPolicy, advertisement()))
      .mockResolvedValueOnce(response(enabledPolicy, disabledRecord));
    renderAgent();
    const toggle = await screen.findByLabelText("Enable advertisement for this agent") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.queryByLabelText("Enable advertisement generation globally")).toBeNull();

    fireEvent.click(toggle);
    await waitFor(() => expect((screen.getByLabelText("Enable advertisement for this agent") as HTMLInputElement).checked).toBe(false));
    expect(fetchMock).toHaveBeenLastCalledWith(endpoint, expect.objectContaining({
      method: "POST", body: JSON.stringify({ agent_id: "saved-agent", action: "disable" }),
    }));
  });

  it("explains how to fix source_size_refused", async () => {
    fetchMock.mockResolvedValueOnce(response(enabledPolicy, advertisement("failed", {
      error: "source_size_refused",
      advertisement: null,
    })));
    renderAgent();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Increase Maximum input characters (up to 16,000)");
    expect(alert.textContent).toContain("Shared tools are already omitted");
    expect(alert.textContent).toContain("shorten the agent name, identity, or instructions");
  });

  it("keeps advertisement controls unavailable until a new agent is saved", () => {
    render(<AdvertisementSection models={[model]} />);
    expect(screen.getByText(/Save this agent first/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces request failures and allows status refresh", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Cannot reach local server"))
      .mockResolvedValueOnce(response(enabledPolicy, advertisement()));
    renderAgent();
    expect((await screen.findByRole("alert")).textContent).toBe("Cannot reach local server");
    fireEvent.click(button("Refresh advertisement"));
    await waitFor(() => expect(screen.getByText("Status: ready")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("enables an individual advertisement without changing global generation", async () => {
    fetchMock.mockResolvedValueOnce(response(defaultPolicy, advertisement("disabled", { enabled: false, advertisement: null })))
      .mockResolvedValueOnce(response(defaultPolicy, advertisement("disabled", { enabled: true, advertisement: null })));
    renderAgent();
    await waitFor(() => expect((screen.getByLabelText("Enable advertisement for this agent") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText("Enable advertisement for this agent"));
    await waitFor(() => expect((screen.getByLabelText("Enable advertisement for this agent") as HTMLInputElement).checked).toBe(true));
    expect(fetchMock).toHaveBeenLastCalledWith(endpoint, expect.objectContaining({
      method: "POST", body: JSON.stringify({ agent_id: "saved-agent", action: "enable" }),
    }));
    expect(button("Regenerate advertisement").disabled).toBe(true);
    expect(screen.getByText(/Global generation is disabled/)).toBeTruthy();
  });

  it("does not change the enable switch or claim success when a mutation fails", async () => {
    fetchMock.mockResolvedValueOnce(response(enabledPolicy, advertisement()))
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: "Unlocked loopback access required" }) });
    renderAgent();
    await waitFor(() => expect((screen.getByLabelText("Enable advertisement for this agent") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText("Enable advertisement for this agent"));
    expect((await screen.findByRole("alert")).textContent).toBe("Unlocked loopback access required");
    expect((screen.getByLabelText("Enable advertisement for this agent") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText("Advertisement disabled.")).toBeNull();
  });

  it("disables regeneration when the explicitly selected model is unavailable", async () => {
    fetchMock.mockResolvedValueOnce(response({ ...enabledPolicy, model_config_name: "Removed model" }, advertisement()));
    renderAgent();
    await screen.findByText("Status: ready");
    expect(button("Regenerate advertisement").disabled).toBe(true);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("rejects mismatched agent responses without exposing another agent's metadata", async () => {
    fetchMock.mockResolvedValueOnce(response(enabledPolicy, advertisement("ready", { agent_id: "different-agent" })));
    renderAgent();
    expect((await screen.findByRole("alert")).textContent).toContain("Invalid advertisement response");
    expect(screen.queryByText(metadata.purpose)).toBeNull();
    expect(button("Regenerate advertisement").disabled).toBe(true);
  });

  it("polls pending generation and stops after completion or unmount", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(response(enabledPolicy, advertisement("pending", { advertisement: null })))
      .mockResolvedValueOnce(response(enabledPolicy, advertisement()));
    const view = renderAgent();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("Status: pending")).toBeTruthy();
    expect(button("Regenerate advertisement").disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText("Status: ready")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders generated markup as text rather than executable HTML", async () => {
    const purpose = '<img src="x" onerror="alert(1)">';
    fetchMock.mockResolvedValueOnce(response(enabledPolicy, advertisement("ready", {
      advertisement: { ...metadata, purpose },
    })));
    renderAgent();
    expect(await screen.findByText(purpose)).toBeTruthy();
    expect(screen.getByLabelText("Read-only generated advertisement").querySelector("img")).toBeNull();
  });
});
