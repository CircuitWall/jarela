import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

// After PR #203 (MCP moved to Tools), the Connections tab is a
// single-section host for the IntegrationsPanel \u2014 no sub-tabs anymore.
// Verifies that ?tab=connections still lands on the integrations panel.

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await page.addInitScript(() => {
    try { localStorage.setItem("jarela:crypto-fallback-banner-dismissed", "1"); } catch { /* sandbox */ }
  });
  await page.goto("/?tab=connections");
});

test("Connections tab renders the integrations panel directly", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Credentials" })).toBeVisible({ timeout: 15_000 });
  // No sub-tab strip remains \u2014 only the integrations panel mounts.
  await expect(page.getByRole("tab", { name: "MCP servers" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Built-in integrations" })).toHaveCount(0);
});
