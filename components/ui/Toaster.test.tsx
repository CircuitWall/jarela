// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Toaster } from "./Toaster";

const mocks = vi.hoisted(() => ({
  toasts: [] as Array<Record<string, unknown>>,
  dispatch: vi.fn(),
}));

vi.mock("@/lib/ui/toasts", () => ({
  dismissToast: vi.fn(),
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
  });

  it("uses a standalone native button to open a toast", () => {
    const { container } = render(<Toaster />);

    const openButton = screen.getByRole("button", { name: "Open notification: Agent replied" });
    const dismissButton = screen.getByRole("button", { name: "Dismiss" });
    expect(openButton.tagName).toBe("BUTTON");
    expect(openButton.contains(dismissButton)).toBe(false);
    expect(container.querySelectorAll("button button")).toHaveLength(0);
  });
});