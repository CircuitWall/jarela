import { test, expect } from "@playwright/test";
import { dismissOverlayBanners, seedMockAgent } from "./helpers";

// Per-panel rendered-element check for the Agents tab.
// Scope accessible controls to the workspace, excluding navigation sidebars.

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await dismissOverlayBanners(page);
  await page.goto("/?tab=agents");
});

for (const width of [1280, 1920]) {
  test(`Agents panel renders header and the create-new affordance at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const workspace = page.getByTestId("workspace-content");
    await expect(workspace.getByRole("heading", { name: "Agents", exact: true })).toBeVisible({ timeout: 15_000 });

    // "New" is the canonical add-button label across every panel.
    await expect(workspace.getByRole("button", { name: "New", exact: true })).toBeVisible();

    // The seeded mock agent appears in the list. seedMockAgent marks the
    // agent is_default=true, which makes ChatView render a hidden
    // welcome-screen tile with the same name; filter to the visible
    // occurrence inside the active Agents panel.
    await expect(workspace.getByText("E2E Mock").filter({ visible: true }).first()).toBeVisible();
  });
}
