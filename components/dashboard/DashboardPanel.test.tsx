// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DashboardPanel } from "./DashboardPanel";

vi.mock("./useDashboardData", () => ({
  useDashboardData: () => ({ days: 30, loading: true, data: null }),
}));
vi.mock("./useCurrencyPreference", () => ({
  useCurrencyPreference: () => ({
    currencyInfo: { currency: "USD", source: "default" },
    currencyMode: "auto",
    manualCurrency: "USD",
  }),
}));

it("provides dashboard colors from the current application theme", () => {
  const { container } = render(<DashboardPanel />);
  const dashboard = container.firstElementChild!;
  const tokens = {
    "bg-primary": "surface",
    "bg-secondary": "surface-2",
    "text-primary": "fg",
    "text-secondary": "fg-muted",
    border: "border",
    accent: "accent",
  };

  for (const [name, token] of Object.entries(tokens)) {
    expect(dashboard.classList.contains(`[--${name}:var(--color-${token})]`)).toBe(true);
  }
  expect(dashboard.contains(screen.getByRole("heading", { name: "Usage dashboard" }))).toBe(true);
  expect(dashboard.contains(screen.getByText("Loading dashboard metrics..."))).toBe(true);
});