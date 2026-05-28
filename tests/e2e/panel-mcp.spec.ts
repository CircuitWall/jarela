import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await page.addInitScript(() => {
    try { localStorage.setItem("jarela:crypto-fallback-banner-dismissed", "1"); } catch { /* sandbox */ }
  });
  await page.goto("/?tab=connections&item=mcp");
});

test("MCP servers tab mounts under Connections with header + add form", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "MCP Servers" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Add MCP server" })).toBeVisible();
});

test("MCP servers list renders without errors when empty", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "MCP Servers" })).toBeVisible({ timeout: 15_000 });
  // The list container is the <main> element; even with zero servers it renders.
  await expect(page.locator("main")).toBeVisible();
});
