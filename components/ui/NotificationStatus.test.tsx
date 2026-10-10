// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NotificationStatus } from "./NotificationStatus";

class DeniedNotification {
  static permission: NotificationPermission = "denied";
  static requestPermission = vi.fn();
}

describe("NotificationStatus", () => {
  beforeEach(() => {
    localStorage.removeItem("jarela:notif-banner-dismissed");
    vi.stubGlobal("Notification", DeniedNotification);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a theme-safe denied state with an accessible dismiss action", async () => {
    render(<NotificationStatus />);

    const copy = await screen.findByText(/OS notifications are blocked/);
    const banner = copy.closest(".rounded-lg");
    expect(banner?.className).toContain("bg-rose-500/10");
    expect(screen.getByRole("button", { name: "Dismiss notification prompt" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification prompt" }));
    expect(screen.queryByText(/OS notifications are blocked/)).toBeNull();
  });
});