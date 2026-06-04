import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

// Regression coverage for the per-turn context-usage bar (PR #111) plus
// its follow-up fixes (#112: persist snapshot-only rows when the
// provider doesn't report usage; #113: bar is a 3 px strip flush with
// the bubble's bottom edge). The mock provider never reports
// input/output tokens, so this exercises the snapshot-only path that
// the original bug silently rejected because `cost_usd` defaulted to
// `null` against a `NOT NULL` column.

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
  await expect(page.getByText(marker).last()).toBeVisible({ timeout: 20_000 });
}

test("context-usage bar renders under the assistant bubble for mock turns", async ({ page }) => {
  const marker = `pw-bar-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await sendMockReply(page, marker);

  // The bar's clickable button carries an aria-label matching the
  // `Context usage: <used> of <total> tokens` pattern. Wait for it to
  // appear after the mock turn streams in and the snapshot row gets
  // persisted by the threads GET refetch.
  const bar = page.getByRole("button", { name: /Context usage: .* of .* tokens/ });
  await expect(bar.last()).toBeVisible({ timeout: 15_000 });
});

test("clicking the context-usage bar toggles the per-tier legend", async ({ page }) => {
  const marker = `pw-bar-toggle-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await sendMockReply(page, marker);

  // Tests in this file share the DB, so `.last()` could resolve to a
  // sibling test's bar. Anchor to the assistant bubble that contains
  // THIS test's marker, then scope both the bar and its legend inside it.
  const bubble = page
    .locator("[data-message-id]")
    .filter({ hasText: marker })
    .last();
  const bar = bubble.getByRole("button", { name: /Context usage: .* of .* tokens/ });
  await expect(bar).toBeVisible({ timeout: 15_000 });

  const legend = bubble.getByText(/Output: .* · Window: /);

  await expect(legend).toHaveCount(0);
  await bar.click();
  await expect(legend.first()).toBeVisible();
  // Toggle off.
  await bar.click();
  await expect(legend).toHaveCount(0);
});

test("the just-streamed bubble stays expanded after the stream finalises", async ({ page }) => {
  // CollapsibleLong used to remount with `defaultOpen=false` when the
  // streaming React instance was replaced by the persisted one, snapping
  // long replies shut while the user was reading. MessageList now
  // threads `isLatest` through to keep the most recent bubble open.
  // The mock `slow=` directive paces the stream so the bubble crosses
  // the CollapsibleLong height threshold during streaming.
  await page.goto("/");
  await page.getByRole("button", { name: /E2E Mock/ }).first().click();
  const composer = page.getByPlaceholder("Message…");
  await expect(composer).toBeEnabled({ timeout: 15_000 });

  // Long reply with paragraph breaks to push past the collapse threshold.
  const marker = `pw-keepopen-${Date.now()}`;
  const longReply = `${marker}\n\n${"lorem ipsum dolor sit amet ".repeat(120)}\n\nEND-${marker}`;
  await composer.fill(`MOCK:reply=${longReply}\nMOCK:slow=10`);
  await page.locator('button[aria-label="Send"]').click();

  // Both the head marker and the tail marker must remain visible after
  // the stream completes — proving the bubble didn't auto-collapse.
  await expect(page.getByText(`END-${marker}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(marker).first()).toBeVisible();
});
