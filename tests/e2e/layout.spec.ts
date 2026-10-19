import { test, expect } from "@playwright/test";
import { seedMockAgent, waitForAppReady } from "./helpers";

// These tests pin down layout regressions on iOS PWA where position:absolute
// elements rode along when the on-screen keyboard scrolled the body up.
// Asserting position:fixed at the DOM level catches the bug before it ships.

test.beforeEach(async ({ request }) => {
  await seedMockAgent(request);
});

test("configuration rails fit within a mobile viewport", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("jarela.experience.mode", "full");
    } catch {
      /* sandboxed origin */
    }
  });

  for (const viewportWidth of [320, 390]) {
    await page.setViewportSize({ width: viewportWidth, height: 844 });
    for (const route of [
      "/?tab=settings",
      "/?tab=profile",
      "/?tab=models",
      "/?tab=credentials&item=network",
    ]) {
      await page.goto(route);
      await waitForAppReady(page);

      const rail = page.locator(".max-w-5xl").first();
      await expect(rail).toBeVisible();
      const bounds = await rail.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewportWidth + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewportWidth);
    }
  }
});

test("menu tray uses position:fixed when open", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByPlaceholder("Message…")).toBeVisible({ timeout: 15_000 });
  await waitForAppReady(page);

  // Open the menu via the hamburger in the header. The button doesn't have
  // a stable aria-label, so locate by its lucide icon's data attr or fall
  // back to clicking the rightmost header button.
  const menuToggle = page
    .locator("header button, [class*='glass'] header button")
    .filter({ has: page.locator("svg") })
    .last();
  await menuToggle.click();

  // The menu tray is the glass-elevated panel. Assert it's positioned fixed,
  // not absolute (the iOS keyboard-pushup regression).
  const tray = page.locator(".glass-elevated.fixed").first();
  await expect(tray).toBeVisible();
  const position = await tray.evaluate((el) => getComputedStyle(el).position);
  expect(position).toBe("fixed");
});

test("navigation stays clickable underneath an overlapping error notification", async ({ page }) => {
  await page.goto("/");
  await waitForAppReady(page);
  await page.getByPlaceholder("Message…").fill("Trigger the scripted provider failure.\nMOCK:error=synthetic-navigation-error");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const notification = page.getByRole("button", { name: "Open notification: Chat stream error", exact: true });
  await expect(notification).toBeVisible({ timeout: 15_000 });

  await page.locator("header button").filter({ has: page.locator("svg") }).last().click();
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  const settingsBounds = await settings.boundingBox();
  const notificationBounds = await notification.boundingBox();
  expect(settingsBounds).not.toBeNull();
  expect(notificationBounds).not.toBeNull();
  const center = {
    x: settingsBounds!.x + settingsBounds!.width / 2,
    y: settingsBounds!.y + settingsBounds!.height / 2,
  };
  expect(center.x).toBeGreaterThan(notificationBounds!.x);
  expect(center.x).toBeLessThan(notificationBounds!.x + notificationBounds!.width);
  expect(center.y).toBeGreaterThan(notificationBounds!.y);
  expect(center.y).toBeLessThan(notificationBounds!.y + notificationBounds!.height);
  await settings.click();
  await expect(page.getByRole("tab", { name: "Credentials", exact: true })).toBeVisible();
  await expect(notification).toBeVisible();
});

test("update banner (when shown) anchors below the header", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByPlaceholder("Message…")).toBeVisible({ timeout: 15_000 });
  await waitForAppReady(page);

  // The banner may or may not be visible depending on whether main/npm
  // reports a newer version. Only assert positioning when it's present.
  const banner = page.locator("[class*='bg-emerald-950']").first();
  if (await banner.count()) {
    const wrapper = banner.locator("xpath=ancestor::div[contains(@class,'fixed')][1]");
    const position = await wrapper.evaluate((el) => getComputedStyle(el).position);
    expect(position).toBe("fixed");
  }
});
