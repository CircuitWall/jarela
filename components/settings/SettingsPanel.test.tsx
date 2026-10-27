// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({
    state: { experienceMode: "essential", selectedItem: { settings: undefined } },
    dispatch: vi.fn(),
  }),
}));
vi.mock("@/hooks/useSettingsAttention", () => ({
  useSettingsAttention: () => ({ credentials: false, models: false }),
}));
vi.mock("@/components/credentials/CredentialsPanel", () => ({
  CredentialsListPanel: () => <div data-testid="settings-content" />,
}));

it("lets settings content use the full workspace width", () => {
  render(<SettingsPanel />);

  expect(screen.getByTestId("settings-content").closest(".workspace-panel")).toBeTruthy();
});
