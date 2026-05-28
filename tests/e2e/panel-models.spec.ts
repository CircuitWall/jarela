import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await page.addInitScript(() => {
    try { localStorage.setItem("jarela:crypto-fallback-banner-dismissed", "1"); } catch { /* sandbox */ }
  });
  await page.goto("/?tab=models");
});

test("Models panel header + seeded model row render", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Model Configs" })).toBeVisible({ timeout: 15_000 });
  // The seeded e2e-mock model should be listed.
  await expect(page.getByText("e2e-mock").first()).toBeVisible();
});

test("Models panel exposes an Add affordance", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Model Configs" })).toBeVisible({ timeout: 15_000 });
  // At least one button to create / configure should be present.
  const buttons = page.locator("main button");
  await expect(buttons.first()).toBeVisible();
});
