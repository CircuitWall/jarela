import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await page.addInitScript(() => {
    try { localStorage.setItem("jarela:crypto-fallback-banner-dismissed", "1"); } catch { /* sandbox */ }
  });
  await page.goto("/?tab=tools&item=mcp");
});

test("MCP servers tab mounts under Tools with header + add affordance", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "MCP Servers" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "New" })).toBeVisible();
});

test("MCP empty-state copy explains what MCP servers are for", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "MCP Servers" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/MCP servers expose tools/)).toBeVisible();
});
