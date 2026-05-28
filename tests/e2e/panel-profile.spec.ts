import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await page.addInitScript(() => {
    try { localStorage.setItem("jarela:crypto-fallback-banner-dismissed", "1"); } catch { /* sandbox */ }
  });
  await page.goto("/?tab=profile");
});

test("Profile panel renders the User Profile header", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "User Profile" })).toBeVisible({ timeout: 15_000 });
});

test("Profile panel mounts the Name + About me form fields", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "User Profile" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("textbox", { name: "Name" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "About me" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save profile" })).toBeVisible();
});

test("Profile panel surfaces persona switcher and Tailscale serve recipe", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "User Profile" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Tailscale serve" })).toBeVisible();
  // Two buttons match "Everything" (one is the "Developer" persona description).
  // Pick the persona toggle that's pressed by default.
  await expect(page.getByRole("button", { name: /Everything\s+No filter/ })).toBeVisible();
});
