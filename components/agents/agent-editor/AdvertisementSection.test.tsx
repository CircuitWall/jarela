// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    version: 1, generation_id: "generation-1", agent_id: "saved-agent", status, source_fingerprint: "source-digest", policy_fingerprint: "policy-digest",
    updated_at: "2026-10-30T12:00:00.000Z", error: null, enabled: true,
    advertisement: metadata, ...extra,
  };
}
function response(policy = defaultPolicy, record: ReturnType<typeof advertisement> | null = null) {
  return { ok: true, json: async () => ({ policy, advertisement: record }) };
}
function renderSaved(models = [model]) {
  return render(<AdvertisementSection agentId="saved-agent" models={models} />);
}
async function loaded() {
  await waitFor(() => expect(screen.getByLabelText("Enable advertisement generation globally").closest("fieldset")?.disabled).toBe(false));
}
function button(name: string) {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
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
  it("requires a saved agent without fetching or exposing generation controls", () => {
    render(<AdvertisementSection models={[model]} />);
    expect(screen.getByText(/Save this agent first/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/committed identity and instructions/).textContent).toContain("Conversations and credentials are not included");
    expect(screen.getByText(/model-generated claims/).textContent).toContain("grant no permissions");
  });

  it("loads without caching, starts disabled, and never chooses the default model implicitly", async () => {
    const pending = deferred<ReturnType<typeof response>>();
    fetchMock.mockReturnValueOnce(pending.promise);
    renderSaved();
    expect(screen.getByText("Loading advertisement status...")).toBeTruthy();
    expect(button("Regenerate advertisement").disabled).toBe(true);
    expect(screen.getByLabelText("Maximum input characters").closest("fieldset")?.disabled).toBe(true);
    await act(async () => { pending.resolve(response()); });
    await loaded();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${endpoint}?agent_id=saved-agent`, expect.objectContaining({
      method: "GET", cache: "no-store", signal: expect.any(AbortSignal),
    }));
    expect((screen.getByLabelText("Enable advertisement generation globally") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Maximum calls per hour") as HTMLInputElement).value).toBe("10");
    expect((screen.getByLabelText("Maximum input characters") as HTMLInputElement).value).toBe("16000");
    expect((screen.getByLabelText("Maximum output tokens") as HTMLInputElement).value).toBe("1024");
    expect((screen.getByLabelText("Generation timeout (ms)") as HTMLInputElement).value).toBe("30000");
    expect(screen.getByText("No advertisement generated for this agent.")).toBeTruthy();
    expect(button("Regenerate advertisement").disabled).toBe(true);
  });

  it("saves only the exact full generation policy after explicit model selection", async () => {
    renderSaved();
    await loaded();
    fireEvent.click(screen.getByLabelText("Enable advertisement generation globally"));
    expect(button("Save generation settings").disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: model.name } });
    fireEvent.change(screen.getByLabelText("Maximum calls per hour"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Maximum input characters"), { target: { value: "4000" } });
    fireEvent.change(screen.getByLabelText("Maximum output tokens"), { target: { value: "512" } });
    fireEvent.change(screen.getByLabelText("Generation timeout (ms)"), { target: { value: "15000" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(button("Regenerate advertisement").disabled).toBe(true);
    const saved = { ...enabledPolicy, max_calls_per_hour: 12, max_input_chars: 4000, max_output_tokens: 512, timeout_ms: 15000 };
    const pending = deferred<ReturnType<typeof response>>();
    fetchMock.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response(saved));
    fireEvent.click(button("Save generation settings"));
    expect(screen.getByText("Saving generation settings...")).toBeTruthy();
    expect(screen.getByRole("combobox").closest("fieldset")?.disabled).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(2, endpoint, expect.objectContaining({
      method: "PUT", cache: "no-store", body: JSON.stringify({ policy: saved }),
      headers: { "content-type": "application/json" },
    }));
    await act(async () => { pending.resolve(response(saved)); });
    await loaded();
    expect(screen.getByText("Generation settings saved.")).toBeTruthy();
    expect(button("Regenerate advertisement").disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([, options]) => options.method !== "POST")).toBe(true);
  });

  it.each([
    ["Maximum calls per hour", "0"],
    ["Maximum input characters", "16001"],
    ["Maximum output tokens", "2.5"],
    ["Generation timeout (ms)", ""],
  ])("rejects out-of-bound or incomplete %s without sending a save", async (label, value) => {
    renderSaved();
    await loaded();
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    expect(button("Save generation settings").disabled).toBe(true);
    expect(screen.getByText(/must be a whole number/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("offers only enabled configured names and does not replace an unavailable saved model", async () => {
    fetchMock.mockResolvedValue(response({ ...enabledPolicy, model_config_name: "Removed model" }));
    renderSaved([model, { ...model, name: "Disabled model", enabled: false }]);
    await loaded();
    expect(screen.getAllByRole("option").map((option) => (option as HTMLOptionElement).value)).toEqual(["", model.name]);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("");
    expect(screen.getByText(/Saved model unavailable: Removed model/)).toBeTruthy();
    expect(button("Regenerate advertisement").disabled).toBe(true);
    expect(button("Save generation settings").disabled).toBe(true);
  });

  it("explains missing configured models rather than falling back", async () => {
    renderSaved([]);
    await loaded();
    expect(screen.getByText(/No enabled models configured/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Enable advertisement generation globally"));
    expect(button("Save generation settings").disabled).toBe(true);
    expect(button("Regenerate advertisement").disabled).toBe(true);
  });

  it("posts regenerate using only the committed agent ID and displays read-only model claims", async () => {
    fetchMock.mockResolvedValueOnce(response(enabledPolicy)).mockResolvedValueOnce(response(enabledPolicy, advertisement()));
    renderSaved();
    await loaded();
    fireEvent.click(button("Regenerate advertisement"));
    expect(fetchMock).toHaveBeenLastCalledWith(endpoint, expect.objectContaining({
      method: "POST", cache: "no-store", body: JSON.stringify({ agent_id: "saved-agent", action: "regenerate" }),
    }));
    expect(await screen.findByText("Status: ready")).toBeTruthy();
    const claims = screen.getByLabelText("Read-only generated advertisement");
    for (const text of [
      metadata.purpose, ...metadata.call_when, ...metadata.do_not_call_for, metadata.inputs, metadata.output, ...metadata.tools,
    ]) expect(within(claims).getByText(text)).toBeTruthy();
    expect(claims.querySelectorAll("input,textarea,select,button,[contenteditable=true]").length).toBe(0);
    expect(screen.getByText("Ready means generated, not verified.")).toBeTruthy();
    expect(screen.getByText("source-digest")).toBeTruthy();
    expect(screen.getByText("policy-digest")).toBeTruthy();
    expect(screen.getByText("2026-10-30T12:00:00.000Z").tagName).toBe("TIME");
  });

  it("uses separate disable and enable actions without changing the global policy", async () => {
    fetchMock.mockResolvedValueOnce(response(enabledPolicy, advertisement()))
      .mockResolvedValueOnce(response(enabledPolicy, advertisement("disabled", { enabled: false })))
      .mockResolvedValueOnce(response(enabledPolicy, advertisement()));
    renderSaved();
    await loaded();
    expect(button("Enable advertisement").disabled).toBe(true);
    fireEvent.click(button("Disable advertisement"));
    await screen.findByText("Status: disabled");
    expect(fetchMock).toHaveBeenLastCalledWith(endpoint, expect.objectContaining({
      method: "POST", body: JSON.stringify({ agent_id: "saved-agent", action: "disable" }),
    }));
    expect(button("Disable advertisement").disabled).toBe(true);
    expect(button("Regenerate advertisement").disabled).toBe(true);
    expect((screen.getByLabelText("Enable advertisement generation globally") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(button("Enable advertisement"));
    await screen.findByText("Status: ready");
    expect(fetchMock).toHaveBeenLastCalledWith(endpoint, expect.objectContaining({
      method: "POST", body: JSON.stringify({ agent_id: "saved-agent", action: "enable" }),
    }));
  });

  it("polls pending status, preserves draft settings, and stops after completion and unmount", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(response(enabledPolicy, advertisement("pending")))
      .mockResolvedValueOnce(response(enabledPolicy, advertisement("ready")));
    const view = renderSaved();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("Status: pending")).toBeTruthy();
    expect(button("Regenerate advertisement").disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Maximum calls per hour"), { target: { value: "15" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(screen.getByText("Status: ready")).toBeTruthy();
    expect((screen.getByLabelText("Maximum calls per hour") as HTMLInputElement).value).toBe("15");
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows failed generation errors and server-reported stale freshness", async () => {
    fetchMock.mockResolvedValueOnce(response(enabledPolicy, advertisement("failed", { error: "Provider timed out", advertisement: null })))
      .mockResolvedValueOnce(response(enabledPolicy, advertisement("stale")));
    renderSaved();
    expect((await screen.findByRole("alert")).textContent).toBe("Generation error: Provider timed out");
    fireEvent.click(button("Refresh advertisement"));
    expect(await screen.findByText("Status: stale")).toBeTruthy();
    expect(screen.getByText(/Stale: committed source/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows initial load failures, prevents mutations, and lets the operator retry", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Cannot reach local server"));
    renderSaved();
    expect((await screen.findByRole("alert")).textContent).toBe("Cannot reach local server");
    expect(button("Regenerate advertisement").disabled).toBe(true);
    expect(screen.getByRole("combobox").closest("fieldset")?.disabled).toBe(true);
    expect(button("Refresh advertisement").disabled).toBe(false);
    fireEvent.click(button("Refresh advertisement"));
    await loaded();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["Save generation settings", "Regenerate advertisement"])("surfaces API refusal for %s without claiming success", async (name) => {
    fetchMock.mockResolvedValueOnce(response(enabledPolicy));
    renderSaved();
    await loaded();
    if (name === "Save generation settings") fireEvent.change(screen.getByLabelText("Maximum calls per hour"), { target: { value: "11" } });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: "Unlocked loopback access required" }) });
    fireEvent.click(button(name));
    expect((await screen.findByRole("alert")).textContent).toBe("Unlocked loopback access required");
    expect(screen.queryByText("Generation settings saved.")).toBeNull();
    expect(screen.queryByText("Regeneration requested.")).toBeNull();
    expect(screen.getByRole("combobox").closest("fieldset")?.disabled).toBe(false);
  });

  it("handles non-JSON server errors and rejects malformed successful data", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => { throw new Error("not JSON"); } })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ policy: enabledPolicy, advertisement: { status: "ready" } }) });
    renderSaved();
    expect((await screen.findByRole("alert")).textContent).toContain("Advertisement request failed (502)");
    fireEvent.click(button("Refresh advertisement"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Invalid advertisement response"));
    expect(button("Regenerate advertisement").disabled).toBe(true);
  });

  it("reports polling failures, then retries instead of silently abandoning pending work", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(response(enabledPolicy, advertisement("pending")))
      .mockRejectedValueOnce(new Error("Status refresh failed"))
      .mockResolvedValueOnce(response(enabledPolicy, advertisement()));
    renderSaved();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(screen.getByRole("alert").textContent).toBe("Status refresh failed");
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(screen.getByText("Status: ready")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cancels the polling timer when unmounted while generation is still pending", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(response(enabledPolicy, advertisement("pending")));
    const view = renderSaved();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("Status: pending")).toBeTruthy();
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders generated markup as text, never as executable HTML or trusted instructions", async () => {
    const purpose = '<img src="x" onerror="alert(1)">';
    fetchMock.mockResolvedValue(response(enabledPolicy, advertisement("ready", { advertisement: { ...metadata, purpose } })));
    renderSaved();
    expect(await screen.findByText(purpose)).toBeTruthy();
    expect(screen.getByLabelText("Read-only generated advertisement").querySelector("img")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts pending requests and discards previous agent state when the saved ID changes", async () => {
    const pending = deferred<ReturnType<typeof response>>();
    fetchMock.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response());
    const view = renderSaved();
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    view.rerender(<AdvertisementSection agentId="another agent" models={[model]} />);
    expect(signal.aborted).toBe(true);
    await loaded();
    expect(fetchMock).toHaveBeenLastCalledWith(`${endpoint}?agent_id=another%20agent`, expect.objectContaining({ method: "GET" }));
    await act(async () => { pending.resolve(response(enabledPolicy, advertisement())); });
    expect(screen.queryByText("Status: ready")).toBeNull();
    expect((screen.getByLabelText("Enable advertisement generation globally") as HTMLInputElement).checked).toBe(false);
  });
});
