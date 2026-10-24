import { test, expect } from "@playwright/test";
import { dismissOverlayBanners, seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await dismissOverlayBanners(page);
  await page.goto("/?tab=profile");
});

test("Profile panel renders the Profile header", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible({ timeout: 15_000 });
});

test("Profile panel mounts the Name + About me form fields", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("textbox", { name: "Name" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "About me" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save profile" })).toBeHidden();
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await name.fill((await name.inputValue()) === "E2E User" ? "E2E Updated User" : "E2E User");
  await expect(page.getByRole("button", { name: "Save profile" })).toBeVisible();
});

test("Profile panel keeps personal settings without the agent persona picker", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Tailscale serve" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Persona", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Home|Work|Developer|Everything)\b/ })).toHaveCount(0);
});

test("Normal mode keeps Profile editor and opens wizard only on demand", async ({ page, request }) => {
  await seedMockAgent(request);
  const seeded = await request.put("/api/v1/profile", { data: { name: "E2E User" } });
  expect(seeded.ok()).toBeTruthy();

  await page.evaluate(() => {
    try { localStorage.setItem("jarela.experience.mode", "essential"); } catch { /* sandbox */ }
  });
  await page.goto("/?tab=profile");

  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible({ timeout: 30_000 });
  const rerunBtn = page.getByRole("button", { name: "Run setup wizard again" });
  await expect(rerunBtn).toBeVisible();

  await rerunBtn.click();
  const exitBtn = page.getByRole("button", { name: "Exit wizard", exact: true });
  await expect(exitBtn).toBeVisible();

  await exitBtn.click();
  await expect(exitBtn).toBeHidden();
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible({ timeout: 15_000 });
});
