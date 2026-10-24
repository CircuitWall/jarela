import { test, expect, type Page } from "@playwright/test";
import { dismissOverlayBanners, seedMockAgent, waitForAppReady } from "./helpers";

// These tests pin down layout regressions on iOS PWA where position:absolute
// elements rode along when the on-screen keyboard scrolled the body up.
// Asserting position:fixed at the DOM level catches the bug before it ships.

test.beforeEach(async ({ request }) => {
  await seedMockAgent(request);
});

async function openIsolatedMockChat(page: Page) {
  const { model } = await seedMockAgent(page.request);
  const response = await page.request.post("/api/v1/agents", {
    data: {
      name: `Layout ${Date.now()}`,
      model_config_name: model,
      tools: [],
      is_default: true,
    },
  });
  expect(response.ok()).toBe(true);
  const agent = await response.json() as { id: string };
  await page.goto(`/?agent=${encodeURIComponent(agent.id)}`);
  await waitForAppReady(page);
}

for (const viewportWidth of [320, 390]) {
  for (const route of [
    "/?tab=settings",
    "/?tab=profile",
    "/?tab=models",
    "/?tab=credentials&item=network",
  ]) {
    test(`configuration rail fits at ${viewportWidth}px: ${route}`, async ({ page }) => {
      await page.addInitScript(() => {
        try {
          localStorage.setItem("jarela.experience.mode", "full");
        } catch {
          /* sandboxed origin */
        }
      });
      await page.setViewportSize({ width: viewportWidth, height: 844 });
      await page.goto(route);
      await waitForAppReady(page);

      const rail = page.locator(".max-w-5xl").first();
      await expect(rail).toBeVisible();
      const bounds = await rail.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewportWidth + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewportWidth);
    });
  }
}

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

test("selecting a header agent closes the open menu", async ({ page }) => {
  await openIsolatedMockChat(page);
  await page.locator("header button").filter({ has: page.locator("svg") }).last().click();
  const menu = page.getByRole("navigation", { name: "Main navigation" });
  await expect(menu).toBeVisible();
  await page.getByRole("group", { name: "Switch agent" }).getByRole("button").first().click();
  await expect(menu).toHaveCount(0);
});

for (const width of [320, 390]) {
  test(`destination menu fits and scrolls at ${width}px`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await dismissOverlayBanners(page);
    await page.addInitScript(() => localStorage.setItem("jarela.experience.mode", "full"));
    await page.setViewportSize({ width, height: 568 });
    await page.goto("/");
    await waitForAppReady(page);
    await page.locator("header button").filter({ has: page.locator("svg") }).last().click();
    const menu = page.getByRole("navigation", { name: "Main navigation" });
    await expect(menu).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const label of ["Agents", "Knowledge", "Automations", "Usage", "Profile", "Settings"]) {
      const button = menu.getByRole("button", { name: label, exact: true });
      await button.scrollIntoViewIfNeeded();
      const bounds = await button.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    await menu.locator("summary").click();
    const capabilities = menu.getByRole("button", { name: "Capabilities", exact: true });
    await capabilities.scrollIntoViewIfNeeded();
    await capabilities.click();
    await expect(menu).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Packages", exact: true })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
}

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
  expect(settingsBounds).not.toBeNull();
  const center = {
    x: settingsBounds!.x + settingsBounds!.width / 2,
    y: settingsBounds!.y + settingsBounds!.height / 2,
  };
  expect(await settings.evaluate((el, point) =>
    el.contains(document.elementFromPoint(point.x, point.y)), center)).toBe(true);
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

test.describe("small-screen header without touch detection", () => {
  test.use({ hasTouch: false, isMobile: false });

  test("header has no glass haze while the chat composer stays frosted", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await waitForAppReady(page);
    expect(await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches)).toBe(false);
    for (const theme of ["light", "dark", "system"]) {
      for (const surface of ["calm", "ambient", "liquid"]) {
        await page.evaluate(({ theme, surface }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.surfaceStyle = surface;
        }, { theme, surface });
        const styles = await page.locator(".app-header").evaluate((el) => {
          const css = getComputedStyle(el);
          return {
            blur: css.getPropertyValue("backdrop-filter") || css.getPropertyValue("-webkit-backdrop-filter"),
            image: css.backgroundImage,
            background: css.backgroundColor,
          };
        });
        expect(styles.blur).toBe("none");
        expect(styles.image).toBe("none");
        expect(styles.background).toMatch(/^rgb\(/);
        const composerBlur = await page.locator(".chat-composer").evaluate((el) => {
          const css = getComputedStyle(el);
          return css.getPropertyValue("backdrop-filter") || css.getPropertyValue("-webkit-backdrop-filter");
        });
        expect(composerBlur).toBe("blur(12px)");
      }
    }
  });
});

test.describe("mobile PWA chrome", () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const width of [320, 390]) {
    test(`turns scroll under frosted controls but new turns stay clear at ${width}px`, async ({ page }) => {
      await dismissOverlayBanners(page);
      await page.setViewportSize({ width, height: 568 });
      await openIsolatedMockChat(page);
      const composer = page.locator(".chat-composer");
      const input = composer.getByRole("textbox");
      const send = composer.getByRole("button", { name: "Send", exact: true });
      const scroller = page.locator(".chat-message-scroll");
      const controls = page.locator(".chat-controls-overlay");
      const banner = page.locator(".chat-filter-banner");
      await input.fill(`MOCK:reply=${"Older turns should remain visible through the frosted panels. ".repeat(35)}`);
      await send.click();
      await expect(input).toHaveValue("");
      await expect(send).toBeVisible({ timeout: 20_000 });
      await expect(scroller.locator("[data-message-id]")).toHaveCount(2);

      await scroller.evaluate((el) => {
        el.scrollTop = 0;
        el.dispatchEvent(new Event("scroll"));
      });
      await expect.poll(async () => {
        const first = await scroller.locator("[data-message-id]").first().boundingBox();
        const top = await banner.boundingBox();
        return !!first && !!top && first.y >= top.y + top.height;
      }).toBe(true);

      // The scroll viewport covers both panels; actual turn rectangles must
      // pass behind each, not stop at their edges as in a reserved flex layout.
      await scroller.evaluate((el) => {
        el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
        el.dispatchEvent(new Event("scroll"));
      });
      await expect.poll(() => scroller.evaluate((el) => {
        const doc = el.ownerDocument;
        const top = doc.querySelector(".chat-filter-banner")!.getBoundingClientRect();
        const bottom = doc.querySelector(".chat-controls-overlay")!.getBoundingClientRect();
        const viewport = el.getBoundingClientRect();
        const turns = Array.from(el.querySelectorAll("[data-message-id]"), (turn) => turn.getBoundingClientRect());
        return viewport.top <= top.top && viewport.bottom >= bottom.bottom
          && turns.some((turn) => turn.top < top.bottom && turn.bottom > top.top)
          && turns.some((turn) => turn.top < bottom.bottom && turn.bottom > bottom.top);
      })).toBe(true);

      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event("scroll"));
      });
      await input.fill(`MOCK:reply=New streaming turn ${"must stay above the controls ".repeat(12)}\nMOCK:slow=60`);
      await send.click();
      const live = scroller.getByTestId("live-turn-activity");
      await expect(live).toBeVisible();
      await expect.poll(async () => {
        const turn = await live.boundingBox();
        const bottom = await controls.boundingBox();
        return !!turn && !!bottom && turn.y + turn.height <= bottom.y - 8;
      }).toBe(true);
      await expect(send).toBeVisible({ timeout: 20_000 });
      await expect(scroller.locator("[data-message-id]")).toHaveCount(4);

      await input.fill("A growing composer\nneeds extra clearance\nfor the newest turn.");
      for (const height of [568, 420]) {
        await page.setViewportSize({ width, height });
        await expect.poll(async () => {
          const last = await scroller.locator("[data-message-id]").last().boundingBox();
          const bottom = await controls.boundingBox();
          return !!last && !!bottom && last.y + last.height <= bottom.y - 8;
        }).toBe(true);
        expect(await scroller.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom)))
          .toBeGreaterThanOrEqual((await controls.boundingBox())!.height + 15);
        expect(await scroller.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--chat-controls-height"))))
          .toBeCloseTo((await controls.boundingBox())!.height, 0);
      }
    });

    test(`filter banner fits narrow and short screens at ${width}px`, async ({ page }) => {
      await dismissOverlayBanners(page);
      await page.setViewportSize({ width, height: 568 });
      await openIsolatedMockChat(page);
      const composer = page.locator(".chat-composer");
      await composer.getByRole("textbox").fill("MOCK:reply=Banner layout check");
      await composer.getByRole("button", { name: /^(Send|Steer)$/ }).click();
      const banner = page.locator(".chat-filter-banner");
      const toggle = banner.getByRole("button", { name: /Filters & focus/ });
      await expect(toggle).toBeVisible();
      const collapsed = await banner.boundingBox();
      expect(collapsed).not.toBeNull();
      expect(collapsed!.x).toBe(0);
      expect(collapsed!.width).toBe(width);
      expect(collapsed!.height).toBeLessThanOrEqual(46);
      expect(await banner.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("0px");
      const frost = await banner.evaluate((el) => {
        const css = getComputedStyle(el);
        return {
          backdrop: css.getPropertyValue("backdrop-filter") || css.getPropertyValue("-webkit-backdrop-filter"),
          background: css.backgroundColor,
        };
      });
      expect(frost.backdrop).toBe("blur(12px)");
      expect(frost.background).toMatch(/(?:0\.6|60%)/);
      await toggle.click();
      const region = banner.getByRole("region", { name: "Message filters and focus" });
      await expect(region).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-controls", (await region.getAttribute("id"))!);
      for (const height of [568, 360]) {
        await page.setViewportSize({ width, height });
        const bounds = await region.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.height).toBeLessThanOrEqual(height * 0.35 + 1);
        for (const button of await region.getByRole("button").all()) {
          const rect = await button.boundingBox();
          expect(rect).not.toBeNull();
          expect(rect!.height).toBeGreaterThanOrEqual(44);
          expect(rect!.x).toBeGreaterThanOrEqual(0);
          expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
        }
        await expect(composer.getByRole("textbox")).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      }
      await toggle.click();
      await expect(region).toHaveCount(0);
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
    });

    test(`composer clears rounded corners without a tall chin at ${width}px`, async ({ page }) => {
      await dismissOverlayBanners(page);
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      await waitForAppReady(page);
      await page.addStyleTag({ content: ":root { --app-safe-top: 59px; --app-safe-bottom: 34px; }" });

      const composer = page.locator(".chat-composer");
      const send = composer.getByRole("button", { name: /^(Send|Steer)$/ });
      const attach = page.getByRole("button", { name: "Attach file or image", exact: true });
      const input = composer.getByRole("textbox");
      await expect(composer).toBeVisible();
      expect(await composer.evaluate((el) => getComputedStyle(el).paddingBottom)).toBe("18px");
      const bounds = await composer.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height).toBeLessThanOrEqual(72);
      expect(bounds!.y + bounds!.height).toBeCloseTo(844, 0);

      for (const control of [attach, send]) {
        const rect = await control.boundingBox();
        expect(rect).not.toBeNull();
        expect(rect!.width).toBeGreaterThanOrEqual(44);
        expect(rect!.height).toBeGreaterThanOrEqual(44);
        const bottomClearance = 844 - rect!.y - rect!.height;
        const sideClearance = Math.min(rect!.x, width - rect!.x - rect!.width);
        expect(bottomClearance).toBeCloseTo(18, 0);
        expect(sideClearance).toBeGreaterThanOrEqual(24);
        // The outer bottom corner of each hit target must fit a 48px screen radius.
        expect(Math.hypot(Math.max(0, 48 - sideClearance), Math.max(0, 48 - bottomClearance)))
          .toBeLessThanOrEqual(48);
      }
      await input.fill("Check the compact mobile composer.");
      await expect(send).toBeEnabled();
      await send.click();
      await expect(input).toHaveValue("");

      // A short viewport models the available space above an open keyboard.
      await page.setViewportSize({ width, height: 420 });
      await page.addStyleTag({ content: ":root { --app-safe-bottom: 0px; }" });
      expect(await composer.evaluate((el) => getComputedStyle(el).paddingBottom)).toBe("8px");
      const keyboardBounds = await send.boundingBox();
      expect(keyboardBounds).not.toBeNull();
      expect(keyboardBounds!.y + keyboardBounds!.height).toBeCloseTo(412, 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }

  test("header stays crisp and composer stays frosted across themes and surface styles", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await waitForAppReady(page);
    const header = page.locator(".app-header");
    for (const theme of ["light", "dark", "system"]) {
      for (const surface of ["calm", "ambient", "liquid"]) {
        await page.evaluate(({ theme, surface }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.surfaceStyle = surface;
        }, { theme, surface });
        const styles = await header.evaluate((el) => {
          const css = getComputedStyle(el);
          return {
            backdrop: css.getPropertyValue("backdrop-filter") || css.getPropertyValue("-webkit-backdrop-filter"),
            background: css.backgroundColor,
            image: css.backgroundImage,
          };
        });
        expect(styles.backdrop).toBe("none");
        expect(styles.image).toBe("none");
        expect(styles.background).toMatch(/^rgb\(/);
        const composerStyles = await page.locator(".chat-composer").evaluate((el) => {
          const css = getComputedStyle(el);
          return {
            backdrop: css.getPropertyValue("backdrop-filter") || css.getPropertyValue("-webkit-backdrop-filter"),
            background: css.backgroundColor,
            image: css.backgroundImage,
          };
        });
        expect(composerStyles.backdrop).toBe("blur(12px)");
        expect(composerStyles.background).toMatch(/(?:0\.6|60%)/);
        expect(composerStyles.image).toBe("none");
      }
    }
  });
});
