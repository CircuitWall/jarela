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
  await page.setViewportSize({ width: 1024, height: 844 });
  await page.goto("/");
  await expect(page.getByPlaceholder("Message…")).toBeVisible({ timeout: 15_000 });
  await waitForAppReady(page);

  await page.getByRole("button", { name: "Menu", exact: true }).click();

  // The menu tray is the glass-elevated panel. Assert it's positioned fixed,
  // not absolute (the iOS keyboard-pushup regression).
  const tray = page.locator(".glass-elevated.fixed").first();
  await expect(tray).toBeVisible();
  const position = await tray.evaluate((el) => getComputedStyle(el).position);
  expect(position).toBe("fixed");
  if (await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches)) {
    expect(await tray.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe("none");
  }
});

test("selecting a header agent closes the open menu", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 844 });
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

for (const width of [1024, 1920]) {
  test(`navigation and error notifications remain accessible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await waitForAppReady(page);
    await page.getByPlaceholder("Message…").fill("Trigger the scripted provider failure.\nMOCK:error=synthetic-navigation-error");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const notification = page.getByRole("button", { name: "Open notification: Chat stream error", exact: true });
    await expect(notification).toBeVisible({ timeout: 15_000 });

    const menu = page.getByRole("navigation", { name: "Main navigation" });
    if (width < 1280) await page.getByRole("button", { name: "Menu", exact: true }).click();
    if (width >= 1280) {
      const notificationBounds = await notification.boundingBox();
      const menuBounds = await menu.boundingBox();
      expect(notificationBounds).not.toBeNull();
      expect(menuBounds).not.toBeNull();
      expect(notificationBounds!.x + notificationBounds!.width).toBeLessThanOrEqual(menuBounds!.x);
      expect(await notification.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      })).toBe(true);
    }
    const settings = page.getByRole("button", { name: "Settings", exact: true });
    await settings.scrollIntoViewIfNeeded();
    await expect(settings).toBeInViewport();
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
}

test("navigation docks progressively without overlapping the workspace", async ({ page }) => {
  await dismissOverlayBanners(page);
  await page.setViewportSize({ width: 1279, height: 900 });
  await openIsolatedMockChat(page);
  const menu = page.getByRole("navigation", { name: "Main navigation" });
  const agents = page.getByRole("complementary", { name: "Agents", exact: true });
  const content = page.getByTestId("workspace-content");
  const menuToggle = page.getByRole("button", { name: "Menu", exact: true });
  await expect(menu).toBeHidden();
  await expect(agents).toBeHidden();
  await expect(menuToggle).toBeVisible();

  for (const width of [1280, 1535, 1536, 1920, 2560, 3440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(menu).toBeVisible();
    await expect(menuToggle).toBeHidden();
    const menuBounds = await menu.boundingBox();
    const contentBounds = await content.boundingBox();
    expect(menuBounds).not.toBeNull();
    expect(contentBounds).not.toBeNull();
    expect(contentBounds!.x + contentBounds!.width).toBe(menuBounds!.x);
    expect(contentBounds!.width).toBeGreaterThanOrEqual(960);
    expect(menuBounds!.width).toBe(320);
    expect(contentBounds!.width).toBe(width - 320 - (width >= 1536 ? 256 : 0));
    expect(menuBounds!.x + menuBounds!.width).toBe(width);
    if (width >= 1536) {
      await expect(agents).toBeVisible();
      const agentBounds = await agents.boundingBox();
      expect(agentBounds).not.toBeNull();
      expect(agentBounds!.width).toBe(256);
      expect(agentBounds!.x + agentBounds!.width).toBe(contentBounds!.x);
      await expect(page.locator("header").getByRole("group", { name: "Switch agent" })).toBeHidden();
    } else {
      await expect(agents).toBeHidden();
      await expect(page.locator("header").getByRole("group", { name: "Switch agent" })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }

  await menu.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(menu).toBeVisible();
  expect((await content.boundingBox())!.width).toBe(1280);
  await agents.getByRole("button", { name: /^Current agent:/ }).click();
  await expect(page.getByPlaceholder("Message…")).toBeVisible();
  await expect(menu).toBeVisible();

  await page.setViewportSize({ width: 1279, height: 900 });
  await expect(menu).toBeHidden();
  await expect(agents).toBeHidden();
  await menuToggle.click();
  await expect(menu).toBeVisible();
  await menu.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(menu).toBeHidden();
});

test("agent details enrich docked sidebars without changing the small-screen drawer", async ({ page }) => {
  await dismissOverlayBanners(page);
  await page.addInitScript(() => localStorage.setItem("jarela.experience.mode", "full"));
  const { model, agent } = await seedMockAgent(page.request);
  const instructions = `## Sidebar working style\n\n- Verify **evidence**.\n- Use \`tools\`.\n\n| Step | Output |\n| --- | --- |\n| Verify | Evidence |\n\n${"More instructions with a very long reference: " + "x".repeat(400)}\n\n${"Additional instructions.\n\n".repeat(40)}Final instruction.`;
  const update = await page.request.put(`/api/v1/agents/${encodeURIComponent(agent)}`, {
    data: { identity: "A **test assistant**.", instructions },
  });
  expect(update.ok()).toBe(true);
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto(`/?agent=${encodeURIComponent(agent)}`);
  await waitForAppReady(page);
  const menu = page.getByRole("navigation", { name: "Main navigation" });
  const summary = menu.getByRole("region", { name: "Selected agent" });
  const sidebar = page.getByRole("complementary", { name: "Agents", exact: true });
  await expect(summary).toBeVisible();
  await expect(summary.getByText("E2E Mock", { exact: true })).toBeVisible();
  await expect(summary.getByText(model, { exact: true })).toHaveCount(0);
  await expect(summary.getByText("Selected tools", { exact: true })).toHaveCount(0);
  const description = summary.getByRole("region", { name: "Agent description" });
  await expect(description.getByRole("heading", { name: "Sidebar working style" })).toBeVisible();
  await expect(description.locator("strong").first()).toHaveText("test assistant");
  await expect(description.getByRole("table")).toBeVisible();
  expect(await description.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await description.getByText("Final instruction.", { exact: true }).scrollIntoViewIfNeeded();
  await expect(description.getByText("Final instruction.", { exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^Current agent:/ }).getByText(`Model: ${model}`, { exact: true })).toBeVisible();
  await expect(sidebar.getByText(/0 selected tools/).first()).toBeVisible();
  await summary.getByRole("button", { name: "Manage agents" }).click();
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeVisible();

  for (const width of [320, 390, 1024, 1279, 1280, 1535, 1536, 1920, 2560]) {
    await page.setViewportSize({ width, height: 900 });
    if (width < 1280) {
      await page.getByRole("button", { name: "Menu", exact: true }).click();
      await expect(menu).toBeVisible();
      await expect(summary).toBeHidden();
      await expect(sidebar).toBeHidden();
      await expect(summary.getByRole("combobox", { name: "Model" })).toHaveCount(0);
      await expect(menu.getByRole("button", { name: "Manage agents" })).toBeHidden();
      await menu.getByRole("button", { name: "Profile", exact: true }).click();
      await expect(menu).toBeHidden();
    } else {
      await expect(summary).toBeVisible();
      const bounds = await summary.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(await description.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

test("desktop agent card saves quick settings and refreshes chat without losing drafts", async ({ page }) => {
  await dismissOverlayBanners(page);
  await page.addInitScript(() => localStorage.setItem("jarela.experience.mode", "full"));
  const { model } = await seedMockAgent(page.request);
  const response = await page.request.post("/api/v1/agents", {
    data: {
      name: `Quick settings ${Date.now()}`,
      model_config_name: null,
      usage_strategy: "balanced",
      voice_enabled: false,
      identity: "Synthetic identity",
      instructions: "Keep these instructions.",
      tools: [],
    },
  });
  expect(response.ok()).toBe(true);
  const agent = await response.json() as { id: string };
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto(`/?agent=${encodeURIComponent(agent.id)}`);
  await waitForAppReady(page);
  const card = page.getByRole("region", { name: "Selected agent" });
  const modelSelect = card.getByRole("combobox", { name: "Model", exact: true });
  const strategySelect = card.getByRole("combobox", { name: "Usage strategy" });
  const voice = card.getByRole("checkbox", { name: "Enable voice" });
  const composer = page.getByPlaceholder("Message…");
  await composer.fill("Preserve this unsent draft.");
  await modelSelect.selectOption(model);
  await expect(card.getByText("Agent settings saved.", { exact: true })).toBeVisible();
  await expect(modelSelect).toHaveValue(model);
  await expect(page.getByRole("complementary", { name: "Agents", exact: true }).getByRole("button", { name: /^Current agent:/ })).toContainText(`Model: ${model}`);
  await strategySelect.selectOption("high_reasoning");
  await expect(strategySelect).toHaveValue("high_reasoning");
  await voice.check();
  await expect(voice).toBeChecked();
  await expect(page.getByRole("button", { name: "Record voice message", exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Preserve this unsent draft.");
  const persisted = await page.request.get(`/api/v1/agents/${encodeURIComponent(agent.id)}`);
  expect(persisted.ok()).toBe(true);
  expect(await persisted.json()).toMatchObject({
    model_config_name: model, usage_strategy: "high_reasoning", voice_enabled: true,
    identity: "Synthetic identity", instructions: "Keep these instructions.", tools: [],
  });
  await modelSelect.selectOption("");
  await expect(modelSelect).toHaveValue("");
  await strategySelect.selectOption("");
  await expect(strategySelect).toHaveValue("");
  await voice.uncheck();
  await expect(voice).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Record voice message", exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue("Preserve this unsent draft.");
  const reset = await page.request.get(`/api/v1/agents/${encodeURIComponent(agent.id)}`);
  expect(await reset.json()).toMatchObject({ model_config_name: null, usage_strategy: null, voice_enabled: false });
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
    test(`turns scroll under fixed controls but new turns stay clear at ${width}px`, async ({ page }) => {
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
      expect(frost.backdrop).toBe("none");
      expect(frost.background).toMatch(/0\.94|94%/);
      const bubbleFilters = () => page.locator(".glass-bubble, .glass-bubble-accent").evaluateAll((els) =>
        els.map((el) => {
          const css = getComputedStyle(el);
          return css.getPropertyValue("backdrop-filter") || css.getPropertyValue("-webkit-backdrop-filter");
        }),
      );
      expect((await bubbleFilters()).length).toBeGreaterThan(0);
      await expect.poll(async () => (await bubbleFilters()).join(", "))
        .toMatch(/^none(?:, none)*$/);
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

  test("header stays crisp and composer stays legible across themes and surface styles", async ({ page }) => {
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
        expect(composerStyles.backdrop).toBe("none");
        expect(composerStyles.background).toMatch(/0\.94|94%/);
        expect(composerStyles.image).toBe("none");
      }
    }
  });
});
