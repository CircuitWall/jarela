import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

// These tests pin down layout regressions on iOS PWA where position:absolute
// elements rode along when the on-screen keyboard scrolled the body up.
// Asserting position:fixed at the DOM level catches the bug before it ships.

test.beforeEach(async ({ request }) => {
  await seedMockAgent(request);
});

test("menu tray uses position:fixed when open", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByPlaceholder("Message…")).toBeVisible({ timeout: 15_000 });

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

test("update banner (when shown) anchors below the header", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByPlaceholder("Message…")).toBeVisible({ timeout: 15_000 });

  // The banner may or may not be visible depending on whether main/npm
  // reports a newer version. Only assert positioning when it's present.
  const banner = page.locator("[class*='bg-emerald-950']").first();
  if (await banner.count()) {
    const wrapper = banner.locator("xpath=ancestor::div[contains(@class,'fixed')][1]");
    const position = await wrapper.evaluate((el) => getComputedStyle(el).position);
    expect(position).toBe("fixed");
  }
});
