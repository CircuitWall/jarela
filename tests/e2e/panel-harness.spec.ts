import { test, expect } from "@playwright/test";
import { dismissOverlayBanners, seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await dismissOverlayBanners(page);
  await page.addInitScript(() => {
    // Harness panel is gated behind the full experience mode (AppShell.tsx).
    try { localStorage.setItem("jarela.experience.mode", "full"); } catch { /* sandbox */ }
  });
  await page.goto("/?tab=agents");
});

test("Harness panel renders the Harnesses header", async ({ page }) => {
  // Harnesses moved to the Agents panel; click the sub-tab to reveal it.
  await page.getByRole("tab", { name: "Harnesses" }).click();
  await expect(page.getByRole("heading", { name: "Harnesses" })).toBeVisible({ timeout: 15_000 });
});
