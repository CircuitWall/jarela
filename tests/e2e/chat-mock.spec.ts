import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

// Full chat round-trip using the mock provider — no LLM keys, fully
// deterministic. Validates: composer → agent run → tool-less reply →
// rendered assistant message.

test.beforeEach(async ({ request }) => {
  await seedMockAgent(request);
});

test("composer sends a message and the mock reply renders", async ({ page }) => {
  await page.goto("/");

  const composer = page.getByPlaceholder("Message…");
  await expect(composer).toBeVisible({ timeout: 15_000 });

  // Use a MOCK directive so we get an exact reply we can assert on.
  const marker = "playwright-e2e-marker-7f9a3";
  await composer.fill(`MOCK:reply=${marker}`);

  // The send button doesn't expose aria-label, but title="Send" is stable.
  await page.locator('button[title="Send"]').click();

  // The mock provider streams the marker back; assert it lands in the
  // rendered message list.
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });
});

test("mock provider can simulate a tool call", async ({ page }) => {
  await page.goto("/");

  const composer = page.getByPlaceholder("Message…");
  await expect(composer).toBeVisible({ timeout: 15_000 });

  // The mock provider emits one tool_call when given MOCK:tool=...
  // The tool itself won't be wired, but the assistant turn must show
  // a tool_use stop reason rather than crashing.
  await composer.fill(`MOCK:tool=mock_tool:{"foo":"bar"}`);
  await page.locator('button[title="Send"]').click();

  // We don't assert on a specific UI affordance here (tool execution UI
  // varies); just ensure the page didn't crash and the composer is ready
  // for the next turn.
  await expect(composer).toBeEnabled({ timeout: 30_000 });
});
