import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

test.beforeEach(async ({ request }) => {
  await seedMockAgent(request);
});

async function sendMockReply(page: import("@playwright/test").Page, marker: string) {
  await page.goto("/");
  await page.getByRole("button", { name: /E2E Mock/ }).first().click();
  const composer = page.getByPlaceholder("Message…");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.fill(`MOCK:reply=${marker}`);
  await page.locator('button[aria-label="Send"]').click();
  await expect(page.getByRole("button", { name: /Drag to move conversation focus/i })).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByText(marker).last()).toBeVisible();
}

async function sendMockReplies(page: import("@playwright/test").Page, count: number, prefix: string) {
  await page.goto("/");
  await page.getByRole("button", { name: /E2E Mock/ }).first().click();
  const composer = page.getByPlaceholder("Message…");
  await expect(composer).toBeEnabled({ timeout: 15_000 });

  for (let i = 0; i < count; i++) {
    const marker = `${prefix}-${i}-${Date.now().toString(36)}`;
    await composer.fill(`MOCK:reply=${marker}`);
    await page.locator('button[aria-label="Send"]').click();
    await expect(page.getByText(marker).last()).toBeVisible({ timeout: 20_000 });
  }

  await expect(page.getByRole("button", { name: /Drag to move conversation focus/i })).toBeEnabled({ timeout: 20_000 });
}

test("drag boundary confirms before changing the conversation focus", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Pointer drag simulation is only stable in Chromium for this spec.");
  const marker = `pw-focus-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await sendMockReply(page, marker);

  const handle = page.getByRole("button", { name: /Drag to move conversation focus/i });
  await expect(handle).toBeVisible();
  const markerBubble = page.getByText(marker).last();
  await expect(markerBubble).toBeVisible();

  const boundaryBefore = page.locator('[data-focus-boundary="1"]').first();
  const beforeBox = await boundaryBefore.boundingBox();
  const markerBox = await markerBubble.boundingBox();
  expect(beforeBox).toBeTruthy();
  expect(markerBox).toBeTruthy();

  const firstCandidate = page.locator('[data-hot-candidate="1"]').first();
  const box = await firstCandidate.boundingBox();
  expect(box).toBeTruthy();

  const targetY = (box?.y ?? 0) + ((box?.height ?? 0) / 2);
  await handle.dispatchEvent("pointerdown", { pointerId: 1, clientY: targetY });
  await handle.dispatchEvent("pointermove", { pointerId: 1, clientY: targetY - 10 });
  await handle.dispatchEvent("pointerup", { pointerId: 1, clientY: targetY });

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Move conversation focus here?")).toBeVisible();
  await dialog.getByRole("button", { name: "Move focus" }).click();
  await expect(dialog).toBeHidden();

  const boundaryAfter = page.locator('[data-focus-boundary="1"]').first();
  await expect(boundaryAfter).toBeVisible();
  await expect.poll(async () => {
    const nextBoundary = await boundaryAfter.boundingBox();
    const nextMarker = await markerBubble.boundingBox();
    if (!nextBoundary || !nextMarker) return null;
    // Once focus is moved to the first loaded message, the divider should sit
    // above that message instead of below the whole visible transcript.
    return nextBoundary.y <= (nextMarker.y + 2);
  }).toBe(true);
});

test("dragging to bottom edge still opens confirmation", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Pointer drag simulation is only stable in Chromium for this spec.");
  await sendMockReplies(page, 7, "pw-edge-scroll");

  const scroller = page.locator(".panel-scrollbar");
  await scroller.evaluate((el) => {
    const node = el as HTMLElement;
    const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
    node.scrollTop = Math.max(0, maxTop - 380);
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.waitForTimeout(50);

  const handle = page.getByRole("button", { name: /Drag to move conversation focus/i }).first();
  await expect(handle).toBeEnabled();

  const beforeMetrics = await scroller.evaluate((el) => {
    const node = el as HTMLElement;
    return {
      top: node.scrollTop,
      max: Math.max(0, node.scrollHeight - node.clientHeight),
    };
  });
  const bottomY = (page.viewportSize()?.height ?? 900) - 4;

  await handle.dispatchEvent("pointerdown", { pointerId: 11, clientY: bottomY - 120 });
  for (let i = 0; i < 18; i++) {
    await handle.dispatchEvent("pointermove", { pointerId: 11, clientY: bottomY });
    await page.waitForTimeout(30);
  }
  const after = await scroller.evaluate((el) => (el as HTMLElement).scrollTop);
  await handle.dispatchEvent("pointerup", { pointerId: 11, clientY: bottomY });

  expect(after).toBeGreaterThanOrEqual(beforeMetrics.top);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Move conversation focus here?")).toBeVisible();
});

