// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    cleanup();
    vi.unstubAllGlobals();
  });

  it("still enables notifications and sends the confirmation before hiding the banner", async () => {
    const confirmation = vi.fn();
    const requestPermission = vi.fn().mockResolvedValue("granted");
    class AvailableNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = requestPermission;
      constructor(title: string, options: NotificationOptions) {
        confirmation(title, options);
      }
    }
    vi.stubGlobal("Notification", AvailableNotification);
    render(<NotificationStatus />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable" }));
    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(confirmation).toHaveBeenCalledWith(
      expect.stringContaining("notifications enabled"),
      expect.objectContaining({ tag: "jarela-enable" }),
    ));
    expect(screen.queryByRole("button", { name: "Enable" })).toBeNull();
    expect(screen.queryByText("test sent")).toBeNull();
  });

  it("renders a theme-safe denied state with an accessible dismiss action", async () => {
    render(<NotificationStatus />);

    const copy = await screen.findByText(/System notifications are blocked/);
    const banner = copy.closest(".rounded-lg");
    expect(banner?.className).toContain("bg-rose-500/10");
    expect(screen.getByRole("button", { name: "Dismiss notification prompt" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification prompt" }));
    expect(screen.queryByText(/System notifications are blocked/)).toBeNull();
  });
});