// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FirstKeySetup } from "./FirstKeySetup";

vi.mock("@/components/ui/Logo", () => ({ Logo: () => <div data-testid="jarela-logo" /> }));
vi.mock("./OnboardingWizard", () => ({
  OnboardingWizard: ({ onReady }: { onReady: () => void }) => (
    <button type="button" onClick={onReady}>Wizard ready</button>
  ),
}));

afterEach(() => vi.useRealTimers());

it("holds the centered Jarela splash until setup data is ready, then reveals the wizard", async () => {
  vi.useFakeTimers();
  render(<FirstKeySetup />);

  expect(screen.getByTestId("setup-boot-screen")).toBeTruthy();
  expect(screen.getByTestId("jarela-logo")).toBeTruthy();
  expect(screen.getByText("Preparing your first setup")).toBeTruthy();
  const readyButton = screen.getByRole("button", { name: "Wizard ready", hidden: true });
  expect(readyButton.closest("div")?.getAttribute("aria-hidden")).toBe("true");

  fireEvent.click(readyButton);
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });

  expect(screen.getByTestId("setup-boot-screen").getAttribute("aria-hidden")).toBe("true");
  expect(screen.getByRole("button", { name: "Wizard ready" }).closest("div")?.getAttribute("aria-hidden")).toBe("false");
});
