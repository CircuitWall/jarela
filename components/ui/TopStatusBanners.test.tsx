// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopStatusBanners } from "./TopStatusBanners";

vi.mock("@/components/ui/CryptoFallbackBanner", () => ({
  CryptoFallbackBanner: () => <div data-testid="crypto-banner" />,
}));
vi.mock("@/components/ui/ServerStatus", () => ({
  ServerStatus: () => <div data-testid="runtime-banner" />,
}));
vi.mock("@/components/ui/UpdateAvailableBanner", () => ({
  UpdateAvailableBanner: () => <div data-testid="update-banner" />,
}));

describe("TopStatusBanners", () => {
  it("stacks existing notices and runtime status beneath the app header", () => {
    render(<TopStatusBanners />);

    const stack = screen.getByTestId("top-status-banners");
    expect(stack.className).toContain("pointer-events-none");
    expect(stack.className).toContain("z-[45]");
    expect(stack.className).toContain("xl:right-[var(--workspace-navigation-width)]");
    expect(stack.className).toContain("2xl:left-[var(--workspace-agents-width)]");
    expect(stack.style.top).toBe("calc(3rem + var(--app-safe-top))");
    expect(stack.querySelector(".flex.flex-col.gap-2")).not.toBeNull();
    expect(Array.from(stack.querySelectorAll("[data-testid$='-banner']"))
      .map((banner) => banner.getAttribute("data-testid")))
      .toEqual(["crypto-banner", "update-banner", "runtime-banner"]);
  });
});
