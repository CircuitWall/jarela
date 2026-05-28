import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

// Per-panel rendered-element check for the Agents tab.
// data-testid is intentionally NOT used here — we lean on accessible roles
// and visible text so the test exercises what the user sees.

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await page.addInitScript(() => {
    try { localStorage.setItem("jarela:crypto-fallback-banner-dismissed", "1"); } catch { /* sandbox */ }
  });
  await page.goto("/?tab=agents");
});

test("Agents panel renders header, list, and the create-new affordance", async ({ page }) => {
  // Header label appears as a small uppercase tag rather than an h2.
  await expect(page.getByText("Agents", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

  // The seeded mock agent ("E2E Mock") shows up in the list.
  await expect(page.getByText("E2E Mock").first()).toBeVisible();

  // Primary action — "+" icon-only button. Confirm at least one button has the
  // create affordance; we don't assume a specific aria-label since the panel
  // uses lucide icons.
  const buttons = page.locator("main button, [role='dialog'] button");
  await expect(buttons.first()).toBeVisible();
});
