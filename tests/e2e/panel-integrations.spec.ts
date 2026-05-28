import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

// The Integrations sub-tab lives under Connections (since Connections
// consolidation in ADR-0033). It hosts the credential-vault forms for the
// built-in providers (Anthropic, OpenAI, Atlassian, GitHub, etc.).

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await page.addInitScript(() => {
    try { localStorage.setItem("jarela:crypto-fallback-banner-dismissed", "1"); } catch { /* sandbox */ }
  });
  await page.goto("/?tab=connections");
});

test("Integrations sub-tab is the default and shows Credentials heading", async ({ page }) => {
  const builtin = page.getByRole("tab", { name: "Built-in integrations" });
  await expect(builtin).toBeVisible({ timeout: 15_000 });
  await expect(builtin).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Credentials" })).toBeVisible();
});

test("Switching to MCP sub-tab swaps the visible panel", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Credentials" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("tab", { name: "MCP servers" }).click();
  await expect(page.getByRole("heading", { name: "MCP Servers" })).toBeVisible();
});
