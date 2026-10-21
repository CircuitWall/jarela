// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ServerStatus } from "./ServerStatus";

vi.mock("@/api/runtime-config", () => ({
  runtimeConfig: () => ({ healthCheckTimeoutMs: 5_000 }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does not block startup while the health check is pending", async () => {
  let respond!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; })));
  const { container } = render(<ServerStatus />);
  expect(container.innerHTML).toBe("");
  expect(screen.queryByRole("button", { name: "Reload now" })).toBeNull();
  await act(async () => { respond(new Response(null, { status: 200 })); });
  expect(container.innerHTML).toBe("");
});

it("waits through transient failures, then reports a persistent outage", async () => {
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
  expect(screen.getByRole("status").textContent).toContain("Server unavailable");
  expect(screen.getByRole("button", { name: "Reload now" })).toBeTruthy();
  expect(screen.queryByText("Failed to fetch")).toBeNull();
});

it("does not show launch progress for a transient failure after startup", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockRejectedValueOnce(new TypeError("Failed to fetch")));
  const { container } = render(<ServerStatus />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(container.innerHTML).toBe("");
});