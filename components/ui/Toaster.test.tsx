// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Toaster } from "./Toaster";

const mocks = vi.hoisted(() => ({
  toasts: [] as Array<Record<string, unknown>>,
  dispatch: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("@/lib/ui/toasts", () => ({
  dismissToast: mocks.dismiss,
  useToasts: () => mocks.toasts,
}));

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ state: { activeTab: "chat" }, dispatch: mocks.dispatch }),
}));

describe("Toaster notification actions", () => {
  beforeEach(() => {
    mocks.toasts = [{
      id: "toast-1",
      kind: "info",
      source: "run",
      sourceLabel: "Reply",
      title: "Agent replied",
      body: "A response is ready.",
      agent_id: "agent-1",
      thread_id: "thread-1",
      created_at: 1,
      ttl: 0,
    }];
    mocks.dispatch.mockReset();
    mocks.dismiss.mockReset();
  });

  afterEach(() => vi.useRealTimers());

  it("uses a standalone native button to open a toast", () => {
    const { container } = render(<Toaster />);

    const openButton = screen.getByRole("button", { name: "Open notification: Agent replied" });
    const dismissButton = screen.getByRole("button", { name: "Dismiss" });
    expect(openButton.tagName).toBe("BUTTON");
    expect(openButton.contains(dismissButton)).toBe(false);
    expect(container.querySelectorAll("button button")).toHaveLength(0);
  });

  it("pauses the remaining lifetime on hover without restarting the full duration", () => {
    vi.useFakeTimers();
    mocks.toasts[0].ttl = 1000;
    const { container } = render(<Toaster />);
    const card = container.querySelector(".pointer-events-auto")!;
    act(() => vi.advanceTimersByTime(400));
    fireEvent.mouseEnter(card);
    act(() => vi.advanceTimersByTime(2000));
    expect(mocks.dismiss).not.toHaveBeenCalled();
    fireEvent.mouseLeave(card);
    act(() => vi.advanceTimersByTime(599));
    expect(mocks.dismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(201));
    expect(mocks.dismiss).toHaveBeenCalledWith("toast-1");
  });

  it("expands error details without navigating or dismissing the toast", () => {
    mocks.toasts[0].kind = "error";
    mocks.toasts[0].details = "Synthetic error details";
    render(<Toaster />);
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByText("Synthetic error details")).toBeTruthy();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });
});