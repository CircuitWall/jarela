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

test("Normal mode keeps Profile editor and opens wizard only on demand", async ({ page, request }) => {
  await seedMockAgent(request);
  const seeded = await request.put("/api/v1/profile", { data: { name: "E2E User" } });
  expect(seeded.ok()).toBeTruthy();

  await page.evaluate(() => {
    try { localStorage.setItem("jarela.experience.mode", "essential"); } catch { /* sandbox */ }
  });
  await page.goto("/?tab=profile");

  await expect(page.getByRole("heading", { name: "User Profile" })).toBeVisible({ timeout: 30_000 });
  const rerunBtn = page.getByRole("button", { name: "Run setup wizard again" });
  await expect(rerunBtn).toBeVisible();

  await rerunBtn.click();
  const backBtn = page.getByRole("button", { name: "Back to profile" });
  await expect(backBtn).toBeVisible();

  await backBtn.dispatchEvent("click");
  await expect(backBtn).toBeHidden();
  await expect(page.getByRole("heading", { name: "User Profile" })).toBeVisible({ timeout: 15_000 });
});
