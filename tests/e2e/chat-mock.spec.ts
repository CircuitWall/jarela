import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

// Full chat round-trip using the mock provider — no LLM keys, fully
// deterministic. Validates: agent select → composer enabled → agent run →
// mock reply → rendered assistant message.

test.beforeEach(async ({ request }) => {
  await seedMockAgent(request);
});

test("composer sends a message and the mock reply renders", async ({ page }) => {
  await page.goto("/");

  // The seeded agent is `is_default=true`, so it renders as the featured
  // "default" card on the empty-state. Click it to set
  // AppContext.activeAgentId, which enables the composer.
  await page.getByRole("button", { name: /E2E Mock/ }).first().click();

  const composer = page.getByPlaceholder("Message…");
  await expect(composer).toBeEnabled({ timeout: 15_000 });

  const marker = "playwright-e2e-marker-7f9a3";
  await composer.fill(`MOCK:reply=${marker}`);

  // The send button has title="Send" but no aria-label.
  await page.locator('button[title="Send"]').click();

  // The mock provider streams the marker back; assert it lands in the
  // rendered message list.
  await expect(page.getByText(marker)).toBeVisible({ timeout: 20_000 });
});
