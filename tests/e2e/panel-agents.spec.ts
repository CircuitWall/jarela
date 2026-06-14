import { test, expect } from "@playwright/test";
import { dismissOverlayBanners, seedMockAgent } from "./helpers";

// Per-panel rendered-element check for the Agents tab.
// data-testid is intentionally NOT used — we lean on accessible roles
// and visible text so the test exercises what the user sees.

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await dismissOverlayBanners(page);
  await page.goto("/?tab=agents");
});

test("Agents panel renders header and the create-new affordance", async ({ page }) => {
  // Header label appears as a small uppercase tag rather than an h2.
  await expect(page.getByText("Agents", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

  // "New" is the canonical add-button label across every panel.
  await expect(page.getByRole("button", { name: "New" })).toBeVisible();

  // The seeded mock agent appears in the list. seedMockAgent marks the
  // agent is_default=true, which makes ChatView render a hidden
  // welcome-screen tile with the same name; filter to the visible
  // occurrence inside the active Agents panel.
  await expect(page.getByText("E2E Mock").filter({ visible: true }).first()).toBeVisible();
});
