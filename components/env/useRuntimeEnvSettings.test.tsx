// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRuntimeEnvSettings, type RuntimeEnvRow } from "./useRuntimeEnvSettings";
import { NetworkEnvEditor } from "@/components/integrations/NetworkEnvEditor";
import { EnvVarsPanel } from "./EnvVarsPanel";

const mocks = vi.hoisted(() => ({ refreshConfig: vi.fn(), confirm: vi.fn() }));
vi.mock("@/api/runtime-config", () => ({ refreshRuntimeConfig: mocks.refreshConfig }));
vi.mock("@/lib/ui/confirm", () => ({ confirmAction: mocks.confirm }));

function row(name: string, category: RuntimeEnvRow["category"]): RuntimeEnvRow {
  return {
    name, category, type: "int", default: 10, current: "10", overridden: false,
    description: "Synthetic setting", phase: "preflight", tier: "A",
    requiresRestart: true, agentWritable: false,
  };
}

const entries = [row("JARELA_PORT", "network"), row("JARELA_TEST_LIMIT", "agent")];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirm.mockResolvedValue(true);
  fetchMock = vi.fn().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => url === "/api/v1/env" ? { entries } : {},
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["runtime", "network"] as const)("keeps %s settings in their original panel", async (scope) => {
  const { result } = renderHook(() => useRuntimeEnvSettings(scope, "synthetic restart"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.rows.map((entry) => entry.name)).toEqual([
    scope === "network" ? "JARELA_PORT" : "JARELA_TEST_LIMIT",
  ]);
});

it("saves and resets exact values, refreshes runtime readers, and retains restart state", async () => {
  const { result } = renderHook(() => useRuntimeEnvSettings("network", "synthetic restart"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.setEditing({ name: "JARELA_PORT", value: "4242" }));
  act(() => result.current.onSave());
  await waitFor(() => expect(result.current.editing).toBeNull());
  expect(fetchMock).toHaveBeenCalledWith("/api/v1/env", expect.objectContaining({
    method: "PATCH", body: JSON.stringify({ name: "JARELA_PORT", value: "4242" }),
  }));
  expect(result.current.restartNeeded).toBe(true);
  expect(mocks.refreshConfig).toHaveBeenCalledOnce();

  act(() => result.current.onReset(entries[0]));
  await waitFor(() => expect(mocks.refreshConfig).toHaveBeenCalledTimes(2));
  expect(fetchMock).toHaveBeenCalledWith("/api/v1/env", expect.objectContaining({
    method: "PATCH", body: JSON.stringify({ name: "JARELA_PORT", value: null }),
  }));
});

it("preserves an unsaved draft and the server error on failure", async () => {
  const { result } = renderHook(() => useRuntimeEnvSettings("network", "synthetic restart"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Synthetic validation failure" }) });
  act(() => result.current.setEditing({ name: "JARELA_PORT", value: "invalid" }));
  act(() => result.current.onSave());
  await waitFor(() => expect(result.current.error).toBe("Synthetic validation failure"));
  expect(result.current.editing?.value).toBe("invalid");
  expect(result.current.saving).toBe(false);
  expect(mocks.refreshConfig).not.toHaveBeenCalled();
});

it("confirms restart, preserves its caller reason and polls health before clearing the banner", async () => {
  const { result } = renderHook(() => useRuntimeEnvSettings("network", "synthetic restart"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  vi.useFakeTimers();
  await act(async () => { await result.current.onRestart(); });
  expect(result.current.restarting).toBe(true);
  expect(fetchMock).toHaveBeenCalledWith("/api/v1/system/restart", expect.objectContaining({
    method: "POST", body: JSON.stringify({ reason: "synthetic restart" }),
  }));
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(fetchMock).toHaveBeenCalledWith("/api/v1/health", { cache: "no-store" });
  expect(result.current.restarting).toBe(false);
  expect(result.current.restartNeeded).toBe(false);
});

it("wires both panels to independent row editors without duplicating network settings", async () => {
  render(<><NetworkEnvEditor /><EnvVarsPanel /></>);
  expect(await screen.findAllByText("JARELA_PORT")).toHaveLength(1);
  expect(await screen.findAllByText("JARELA_TEST_LIMIT")).toHaveLength(1);
  const network = within(screen.getByText("JARELA_PORT").closest("li")!);
  fireEvent.click(network.getByRole("button", { name: "Edit" }));
  const port = screen.getByLabelText("JARELA_PORT");
  fireEvent.change(port, { target: { value: "4242" } });
  fireEvent.keyDown(port, { key: "Enter" });
  await waitFor(() => expect(screen.queryByLabelText("JARELA_PORT")).toBeNull());
  expect(fetchMock).toHaveBeenCalledWith("/api/v1/env", expect.objectContaining({
    body: JSON.stringify({ name: "JARELA_PORT", value: "4242" }),
  }));
  const runtime = within(screen.getByText("JARELA_TEST_LIMIT").closest("li")!);
  fireEvent.click(runtime.getByRole("button", { name: "Edit" }));
  const input = screen.getByLabelText("JARELA_TEST_LIMIT");
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByLabelText("JARELA_TEST_LIMIT")).toBeNull();
});
