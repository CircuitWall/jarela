// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ServerStatus } from "./ServerStatus";
import { SERVER_ACTIVITY_EVENT } from "@/api/health";

vi.mock("@/api/runtime-config", () => ({
  runtimeConfig: () => ({ healthCheckTimeoutMs: 5_000 }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function liveness(activeRuns = 0): Response {
  return new Response(JSON.stringify({ status: "ok", activity: { active_runs: activeRuns } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function details(agentIds = ["agent-a"]): Response {
  return new Response(JSON.stringify({ status: "ok", agents: agentIds, crypto: { source: "keychain" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

it("does not block startup while the health check is pending", async () => {
  let respondHealth!: (response: Response) => void;
  let respondDetails!: (response: Response) => void;
  const fetch = vi.fn((url: string) => new Promise<Response>((resolve) => {
    if (url.endsWith("/health")) respondDetails = resolve;
    else respondHealth = resolve;
  }));
  vi.stubGlobal("fetch", fetch);
  const { container } = render(<ServerStatus />);
  expect(container.innerHTML).toBe("");
  expect(screen.queryByRole("button", { name: "Reload now" })).toBeNull();
  expect(fetch).toHaveBeenCalledWith("/api/v1/health/liveness", expect.objectContaining({ cache: "no-store" }));
  await act(async () => { respondHealth(liveness(1)); });
  expect(screen.getByRole("status").textContent).toContain("checking runtime details");
  expect(screen.getByRole("status").textContent).toContain("1 agent run is active");
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/v1/health/liveness", "/api/v1/health"]);
  await act(async () => { respondDetails(details(["agent-a", "agent-b"])); });
  expect(screen.getByRole("status").textContent).toContain("found 2 agent configurations");
  expect(screen.getByRole("status").textContent).toContain("1 agent run is active");
});

it("does not overlap health probes when the document becomes visible", async () => {
  const responses: Array<(response: Response) => void> = [];
  const fetch = vi.fn(() => new Promise<Response>((resolve) => { responses.push(resolve); }));
  vi.stubGlobal("fetch", fetch);
  const visibilityState = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const { unmount } = render(<ServerStatus />);

  try {
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetch.mock.calls.filter(([url]) => url === "/api/v1/health/liveness")).toHaveLength(1);
    await act(async () => { responses[0](liveness()); });
    await act(async () => { responses[1](details()); });
  } finally {
    unmount();
    visibilityState.mockRestore();
  }
});

it("waits through a sustained outage before reporting the server unavailable", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
  vi.stubGlobal("fetch", fetch);
  render(<ServerStatus />);
  await act(async () => {});
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(24_999); });
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByRole("status").textContent).toContain("Server unavailable");
  expect(screen.getByRole("button", { name: "Reload now" })).toBeTruthy();
  expect(screen.queryByText("Failed to fetch")).toBeNull();
});

it("clears the outage overlay when an active workflow stream responds", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
  render(<ServerStatus />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
  expect(screen.getByRole("status").textContent).toContain("Server unavailable");

  await act(async () => {
    window.dispatchEvent(new Event(SERVER_ACTIVITY_EVENT));
  });
  expect(screen.getByRole("status").textContent).toContain("responding to the active workflow");
  expect(screen.queryByText("Server unavailable")).toBeNull();
});

it("does not show launch progress for a transient failure after startup", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(liveness())
    .mockResolvedValueOnce(details())
    .mockRejectedValueOnce(new TypeError("Failed to fetch")));
  const { container } = render(<ServerStatus />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(container.innerHTML).toBe("");
});

it("keeps liveness green when deeper diagnostics fail", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(liveness())
    .mockRejectedValueOnce(new TypeError("diagnostics unavailable")));
  render(<ServerStatus />);
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toContain("runtime details could not be checked");
  expect(screen.queryByText("Server unavailable")).toBeNull();
});