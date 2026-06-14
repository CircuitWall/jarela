import { test, expect } from "@playwright/test";
import { dismissOverlayBanners, seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await dismissOverlayBanners(page);
  await page.addInitScript(() => {
    // Memory panel is gated behind the advanced experience mode (AppShell.tsx).
    try { localStorage.setItem("jarela.experience.mode", "full"); } catch { /* sandbox */ }
  });
  await page.goto("/?tab=memory");
});

test("Memory panel renders header, search, and namespace filter", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Memory Store" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("textbox", { name: "Search…" })).toBeVisible();
  await expect(page.getByRole("combobox")).toBeVisible();
});

test("Memory panel exposes a way to add a new memory entry", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Memory Store" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "New" })).toBeVisible();
});
