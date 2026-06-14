import { test, expect } from "@playwright/test";
import { dismissOverlayBanners, seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await dismissOverlayBanners(page);
  await page.goto("/?tab=models");
});

test("Models panel header + seeded model row render", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Model Configs" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("e2e-mock").first()).toBeVisible();
});

test("Models panel exposes an Add affordance", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Model Configs" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "New" })).toBeVisible();
});
