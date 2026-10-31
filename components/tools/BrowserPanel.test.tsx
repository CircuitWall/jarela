// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { BrowserPanel } from "./BrowserPanel";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  tabs: vi.fn(),
  history: vi.fn(),
  activate: vi.fn(),
  retry: vi.fn(),
  errorToast: vi.fn(),
}));

vi.mock("@/api/client", () => ({
  api: {
    browser: {
      status: mocks.status,
      tabs: mocks.tabs,
      history: mocks.history,
      activateTab: mocks.activate,
      retry: mocks.retry,
    },
  },
}));
vi.mock("@/lib/ui/toasts", () => ({ pushToast: vi.fn() }));
vi.mock("@/lib/ui/error-report", () => ({ pushErrorToast: mocks.errorToast }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.mockResolvedValue({ connected: true, lastSeenMs: 1, pendingCommands: 0 });
  mocks.tabs.mockResolvedValue({
    total: 1,
    tabs: [{ tab_id: 7, window_id: 1, title: "Example tab", usable: true }],
  });
  mocks.history.mockResolvedValue({
    commands: [{ cmd_id: "cmd-1", summary: "Read example", status: "failed", retryable: true, type: "read" }],
  });
});

it("loads status before tabs and history, then refreshes after activation and retry", async () => {
  render(<BrowserPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Focus" }));
  await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
  expect(mocks.activate).toHaveBeenCalledWith(7);
  expect(mocks.tabs).toHaveBeenCalledWith({ includeUnusable: true });
  expect(mocks.status.mock.invocationCallOrder[0]).toBeLessThan(mocks.tabs.mock.invocationCallOrder[0]);
  expect(mocks.tabs.mock.invocationCallOrder[0]).toBeLessThan(mocks.history.mock.invocationCallOrder[0]);

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(3));
  expect(mocks.retry).toHaveBeenCalledWith("cmd-1");
});

it("keeps actionable errors visible when focusing fails", async () => {
  mocks.activate.mockRejectedValueOnce(new Error("Tab closed"));
  render(<BrowserPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Focus" }));
  await screen.findByText("Tab closed");
  expect(mocks.errorToast).toHaveBeenCalledWith(expect.objectContaining({
    title: "Couldn't focus browser tab",
    context: { panel: "browser", tab_id: 7 },
  }));
  expect(mocks.status).toHaveBeenCalledTimes(1);
});
