import { test, expect } from "@playwright/test";
import { dismissOverlayBanners, seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await dismissOverlayBanners(page);
  await page.addInitScript(() => {
    // Bridges panel is gated behind the full experience mode (AppShell.tsx).
    try { localStorage.setItem("jarela.experience.mode", "full"); } catch { /* sandbox */ }
  });
  await page.goto("/?tab=bridges");
});

test("Bridges panel renders the Bridges header", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Bridges" })).toBeVisible({ timeout: 15_000 });
});
