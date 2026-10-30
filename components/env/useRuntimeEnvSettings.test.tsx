// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRuntimeEnvSettings, type RuntimeEnvRow } from "./useRuntimeEnvSettings";
import { NetworkEnvEditor } from "@/components/integrations/NetworkEnvEditor";
import { EnvVarsPanel } from "./EnvVarsPanel";
import { StrictMode } from "react";

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
  expect(fetchMock).toHaveBeenCalledWith("/api/v1/health", expect.objectContaining({ cache: "no-store" }));
  expect(result.current.restarting).toBe(false);
  expect(result.current.restartNeeded).toBe(false);
});

it("reports rejected restart requests without polling an already healthy server", async () => {
  const { result } = renderHook(() => useRuntimeEnvSettings("network", "synthetic restart"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.onReset(entries[0]));
  await waitFor(() => expect(result.current.restartNeeded).toBe(true));
  fetchMock.mockResolvedValueOnce({
    ok: false, status: 403, statusText: "Forbidden", json: async () => ({ error: "Restart denied" }),
  });
  await act(async () => { await result.current.onRestart(); });
  expect(result.current.error).toBe("Restart denied");
  expect(result.current.restarting).toBe(false);
  expect(result.current.restartNeeded).toBe(true);
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/health")).toBe(false);
});

it("retains the editor draft when a successful write cannot reload the settings", async () => {
  const { result } = renderHook(() => useRuntimeEnvSettings("network", "synthetic restart"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  fetchMock.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error("Reload unavailable"));
  act(() => result.current.setEditing({ name: "JARELA_PORT", value: "4242" }));
  act(() => result.current.onSave());
  await waitFor(() => expect(result.current.saving).toBe(false));
  expect(result.current.error).toBe("Reload unavailable");
  expect(result.current.editing?.value).toBe("4242");
});

it("does not restart after an unmounted confirmation resolves", async () => {
  let confirm!: (value: boolean) => void;
  mocks.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { confirm = resolve; }));
  const { result, unmount } = renderHook(() => useRuntimeEnvSettings("network", "synthetic restart"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  let restart!: Promise<void>;
  act(() => { restart = result.current.onRestart(); });
  unmount();
  await act(async () => { confirm(true); await restart; });
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/system/restart")).toBe(false);
});

it("cancels the owned health-poll timer on unmount", async () => {
  const { result, unmount } = renderHook(() => useRuntimeEnvSettings("network", "synthetic restart"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  vi.useFakeTimers();
  await act(async () => { await result.current.onRestart(); });
  unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/health")).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds health polling even if a health request never responds", async () => {
  const { result } = renderHook(() => useRuntimeEnvSettings("network", "synthetic restart"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url !== "/api/v1/health") return { ok: true, json: async () => ({ entries }) };
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  });
  vi.useFakeTimers();
  await act(async () => { await result.current.onRestart(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(result.current.error).toBe("Server didn't come back within 30s — check it manually.");
  expect(result.current.restarting).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores an obsolete load when the panel scope changes", async () => {
  let resolve!: (response: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const { result, rerender } = renderHook(
    ({ scope }: { scope: "network" | "runtime" }) => useRuntimeEnvSettings(scope, "synthetic restart"),
    { initialProps: { scope: "network" } },
  );
  const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
  rerender({ scope: "runtime" });
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { resolve({ ok: true, json: async () => ({ entries }) }); });
  expect(signal.aborted).toBe(true);
  expect(result.current.rows.map((entry) => entry.name)).toEqual(["JARELA_TEST_LIMIT"]);
});

it("aborts pending writes on unmount without reloading or refreshing runtime readers", async () => {
  const { result, unmount } = renderHook(() => useRuntimeEnvSettings("network", "synthetic restart"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  let resolve!: (response: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  act(() => result.current.onReset(entries[0]));
  const signal = fetchMock.mock.calls[1][1].signal as AbortSignal;
  unmount();
  await act(async () => { resolve({ ok: true }); });
  expect(signal.aborted).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(mocks.refreshConfig).not.toHaveBeenCalled();
});

it("aborts an in-flight health fetch when the panel unmounts", async () => {
  const { result, unmount } = renderHook(() => useRuntimeEnvSettings("network", "synthetic restart"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  let healthSignal!: AbortSignal;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url !== "/api/v1/health") return { ok: true };
    healthSignal = init!.signal!;
    return new Promise((_resolve, reject) => {
      healthSignal.addEventListener("abort", () => reject(healthSignal.reason), { once: true });
    });
  });
  vi.useFakeTimers();
  await act(async () => { await result.current.onRestart(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  unmount();
  await act(async () => {});
  expect(healthSignal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("coalesces repeated restart clicks while confirmation is pending", async () => {
  let confirm!: (value: boolean) => void;
  mocks.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { confirm = resolve; }));
  const { result } = renderHook(() => useRuntimeEnvSettings("network", "synthetic restart"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  let first!: Promise<void>;
  act(() => { first = result.current.onRestart(); });
  await act(async () => { await result.current.onRestart(); });
  expect(mocks.confirm).toHaveBeenCalledOnce();
  await act(async () => { confirm(false); await first; });
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/system/restart")).toBe(false);
  mocks.confirm.mockResolvedValueOnce(false);
  await act(async () => { await result.current.onRestart(); });
  expect(mocks.confirm).toHaveBeenCalledTimes(2);
});

it("falls back to the HTTP status when a restart error is not JSON", async () => {
  const { result } = renderHook(() => useRuntimeEnvSettings("network", "synthetic restart"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  fetchMock.mockResolvedValueOnce({
    ok: false, status: 503, statusText: "Unavailable", json: async () => { throw new SyntaxError("not JSON"); },
  });
  await act(async () => { await result.current.onRestart(); });
  expect(result.current.error).toBe("503 Unavailable");
  expect(result.current.restarting).toBe(false);
});

it("recreates its request ownership during StrictMode effect replay", async () => {
  const { result } = renderHook(() => useRuntimeEnvSettings("network", "synthetic restart"), { wrapper: StrictMode });
  await waitFor(() => expect(result.current.loading).toBe(false));
  const signals = fetchMock.mock.calls.map(([, options]) => options.signal as AbortSignal);
  expect(signals).toHaveLength(2);
  expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false);
  expect(result.current.rows.map((entry) => entry.name)).toEqual(["JARELA_PORT"]);
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
