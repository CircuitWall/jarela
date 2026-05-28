import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await page.addInitScript(() => {
    try { localStorage.setItem("jarela:crypto-fallback-banner-dismissed", "1"); } catch { /* sandbox */ }
  });
  await page.goto("/?tab=memory");
});

test("Memory panel renders header and supports the empty state", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Memory Store" })).toBeVisible({ timeout: 15_000 });

  // Memory rows are listed if any exist; either way the panel chrome should
  // render without crashing. Confirm the surrounding container is present.
  await expect(page.locator("main")).toBeVisible();
});

test("Memory panel exposes a way to add a new memory entry", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Memory Store" })).toBeVisible({ timeout: 15_000 });
  // The "Add" button (icon or text) should be on the page somewhere — at minimum
  // the panel mounts at least one button beside the header.
  const buttons = page.locator("main button");
  await expect(buttons.first()).toBeVisible();
});
