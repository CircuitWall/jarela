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
    vi.stubGlobal("Notification", DeniedNotification);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("enables notifications from the existing navigation-style control", async () => {
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
    const { container } = render(<NotificationStatus />);
    const enableButton = await screen.findByRole("button", { name: /Enable system alerts/ });
    expect(enableButton.className).toContain("control-tap");
    expect(enableButton.className).not.toContain("fixed");
    expect(enableButton.className).not.toContain("absolute");
    fireEvent.click(enableButton);
    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(confirmation).toHaveBeenCalledWith(
      expect.stringContaining("notifications enabled"),
      expect.objectContaining({ tag: "jarela-enable" }),
    ));
    expect(screen.queryByRole("button", { name: /Enable system alerts/ })).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("explains how to re-enable notifications when browser permission is denied", async () => {
    render(<NotificationStatus />);

    await screen.findByText(/System alerts are blocked/);
    expect(await screen.findByText(/browser site settings/)).toBeTruthy();
    expect(screen.getByRole("status").className).toContain("control-tap");
    expect(screen.queryByRole("button", { name: /Enable system alerts/ })).toBeNull();
  });
});