// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ClaudeCodeSetupGuide, GmailSetupGuide, OutlookSetupGuide } from "./IntegrationSetupGuides";

it.each([
  ["Gmail", GmailSetupGuide, "Create or pick a Google Cloud project"],
  ["Outlook", OutlookSetupGuide, "Sign in to the Azure portal"],
  ["Claude Code", ClaudeCodeSetupGuide, "Install Claude Code"],
] as const)("loads %s content only after its disclosure is opened", async (_name, Guide, heading) => {
  const { container } = render(<Guide />);
  expect(screen.queryByText(heading)).toBeNull();
  const details = container.querySelector("details")!;
  await act(async () => {
    details.open = true;
    fireEvent(details, new Event("toggle"));
  });
  expect(await screen.findByText(heading)).not.toBeNull();
  expect(container.querySelectorAll("details")).toHaveLength(1);
  await act(async () => {
    details.open = false;
    fireEvent(details, new Event("toggle"));
  });
  expect(screen.getByText(heading)).not.toBeNull();
});
