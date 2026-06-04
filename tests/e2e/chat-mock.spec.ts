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

  // Unique per test run so previous runs (the SQLite DB at
  // JARELA_DB_DIR=/tmp/jarela-e2e persists across Playwright retries and
  // across the chromium-desktop / mobile-safari projects) don't leave
  // matching messages that would trip strict-mode locator resolution.
  const marker = `pw-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await composer.fill(`MOCK:reply=${marker}`);

  // Send button exposes aria-label="Send" when idle; its title string
  // changes between idle and streaming, so prefer the accessible name.
  await page.locator('button[aria-label="Send"]').click();

  // The mock provider streams the marker back; assert it lands in the
  // rendered message list. Use .last() because the marker also appears
  // inside the user-message bubble that echoes "MOCK:reply=<marker>".
  await expect(page.getByText(marker).last()).toBeVisible({ timeout: 20_000 });
});
