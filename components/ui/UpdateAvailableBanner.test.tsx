// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UpdateAvailableBanner } from "./UpdateAvailableBanner";

const info = {
  channel: "main",
  current: "1.0.0",
  latest: "1.0.1",
  behind: true,
  latestCommit: { sha: "abcdef123" },
};

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("persists main-channel dismissal by version and commit", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => info }));
  const { unmount } = render(<UpdateAvailableBanner />);
  fireEvent.click(await screen.findByRole("button", { name: "Dismiss update notice" }));
  expect(window.localStorage.getItem("jarela:update-banner-dismissed-for")).toBe("1.0.1@abcdef123");
  expect(screen.queryByText("Experimental update available:")).toBeNull();
  unmount();
  render(<UpdateAvailableBanner />);
  await act(async () => {});
  expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
});

it("starts application, polls running jobs, and cancels pending polling on unmount", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ json: async () => info })
    .mockResolvedValueOnce({ ok: true, status: 200 })
    .mockResolvedValue({ ok: true, json: async () => ({ state: "running", lines: ["Installing"] }) });
  vi.stubGlobal("fetch", fetchMock);
  const { unmount } = render(<UpdateAvailableBanner />);
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Update now" })));
  expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/update/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  expect(screen.getByText("Installing")).toBeTruthy();
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  act(() => vi.advanceTimersByTime(5000));
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
