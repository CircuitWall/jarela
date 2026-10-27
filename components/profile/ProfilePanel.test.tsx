// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProfilePanel } from "./ProfilePanel";

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ state: { experienceMode: "essential" } }),
}));
vi.mock("@/hooks/useDeepLinkScroll", () => ({ useDeepLinkScroll: vi.fn() }));
vi.mock("@/components/ui/PanelHeader", () => ({
  PanelHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
}));
vi.mock("@/components/setup/OnboardingWizard", () => ({
  OnboardingWizard: () => <div data-testid="wizard">Wizard</div>,
}));
vi.mock("./ProfileEditor", () => ({ ProfileEditor: () => <div data-testid="profile-editor">Profile editor</div> }));

it("lets users exit a setup rerun without finishing it", () => {
  render(<ProfilePanel />);
  fireEvent.click(screen.getByRole("button", { name: "Run setup wizard again" }));

  expect(screen.getByTestId("wizard")).toBeTruthy();
  expect(screen.getByText(/Credentials, models, and agents stay unchanged/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Exit wizard" }));

  expect(screen.queryByTestId("wizard")).toBeNull();
  expect(screen.getByTestId("profile-editor")).toBeTruthy();
});

it("lets the profile editor use the full workspace width", () => {
  render(<ProfilePanel />);

  expect(screen.getByTestId("profile-editor").closest(".workspace-panel")).toBeTruthy();
});
