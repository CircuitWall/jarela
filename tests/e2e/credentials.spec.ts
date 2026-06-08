import { test, expect } from "@playwright/test";
import { seedMockAgent, waitForAppReady } from "./helpers";

// Coverage for the Credentials consolidation (Connections folded back in
// as a sub-tab) + Built-in tool toggles. Tests run serially: they share
// the dev-server's JARELA_DB_DIR, so toggles set by one test would leak.
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  // Reset every category to enabled so prior runs don't leak.
  const resp = await request.get("/api/v1/builtin-tools");
  if (resp.ok()) {
    const rows = (await resp.json()) as Array<{ category: string; enabled: boolean }>;
    for (const row of rows) {
      if (!row.enabled) {
        await request.patch("/api/v1/builtin-tools", {
          data: { category: row.category, enabled: true },
        });
      }
    }
  }
  await page.addInitScript(() => {
    try { localStorage.setItem("jarela:crypto-fallback-banner-dismissed", "1"); } catch { /* sandbox */ }
  });
  await page.goto("/");
  await expect(page.getByPlaceholder("Message…")).toBeVisible({ timeout: 15_000 });
  await waitForAppReady(page);
});

async function openMenu(page: import("@playwright/test").Page) {
  const menuToggle = page
    .locator("header button")
    .filter({ has: page.locator("svg") })
    .last();
  await menuToggle.click();
  await expect(page.locator(".glass-elevated.fixed").first()).toBeVisible();
}

test("Credentials tab exposes API keys + Built-in integrations sub-tabs", async ({ page }) => {
  await openMenu(page);
  await page.getByRole("button", { name: "Credentials", exact: true }).click();

  const listTab = page.getByRole("tab", { name: "API keys & secrets" });
  const integrationsTab = page.getByRole("tab", { name: "Built-in integrations" });

  await expect(listTab).toBeVisible();
  await expect(integrationsTab).toBeVisible();
  await expect(listTab).toHaveAttribute("aria-selected", "true");

  // Default sub-tab is the credentials list, which renders its known heading.
  await expect(page.getByRole("heading", { name: "Credentials" })).toBeVisible();

  // Switch to Built-in integrations — that panel mounts with its own heading.
  await integrationsTab.click();
  await expect(integrationsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Built-in integrations" })).toBeVisible();
});

test("deep link ?tab=credentials&item=integrations lands directly on Built-in integrations sub-tab", async ({ page }) => {
  await page.goto("/?tab=credentials&item=integrations");
  await expect(page.getByRole("tab", { name: "Built-in integrations" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("heading", { name: "Built-in integrations" })).toBeVisible();
});

test("Built-in tools panel lists categories and toggles persist", async ({ page, request }) => {
  await openMenu(page);
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  // Built-in is the default sub-tab.
  await expect(page.getByRole("heading", { name: "Built-in tools" })).toBeVisible();

  // At least the Memory category card should render.
  const memoryRow = page.locator("li", { hasText: /^Memory/ }).first();
  await expect(memoryRow).toBeVisible();

  // Toggle Memory off via its checkbox. The checkbox is React-controlled
  // (DOM state only flips after the API resolves), so click + assertion
  // instead of .uncheck()/.check().
  const memoryToggle = memoryRow.locator('input[type="checkbox"]');
  await expect(memoryToggle).toBeChecked();
  await memoryToggle.click();
  await expect(memoryToggle).not.toBeChecked();

  // API now reflects the change.
  const after = await request.get("/api/v1/builtin-tools");
  expect(after.ok()).toBeTruthy();
  const rows = (await after.json()) as Array<{ category: string; enabled: boolean }>;
  const mem = rows.find((r) => r.category === "Memory");
  expect(mem?.enabled).toBe(false);

  // Re-enable to leave the world the way we found it.
  await memoryToggle.click();
  await expect(memoryToggle).toBeChecked();
});

test("disabling a category hides its tools from /api/v1/tools (agent permission feed)", async ({ request }) => {
  // Snapshot the tool list before.
  const before = await request.get("/api/v1/tools");
  expect(before.ok()).toBeTruthy();
  const beforeTools = (await before.json()) as Array<{ name: string; category?: string }>;
  const webBefore = beforeTools.filter((t) => t.category === "Web");
  expect(webBefore.length).toBeGreaterThan(0);

  // Disable Web.
  const patch = await request.patch("/api/v1/builtin-tools", {
    data: { category: "Web", enabled: false },
  });
  expect(patch.ok()).toBeTruthy();

  try {
    const after = await request.get("/api/v1/tools");
    expect(after.ok()).toBeTruthy();
    const afterTools = (await after.json()) as Array<{ name: string; category?: string }>;
    expect(afterTools.filter((t) => t.category === "Web")).toEqual([]);
  } finally {
    // Always re-enable so later tests / the dev environment aren't left broken.
    await request.patch("/api/v1/builtin-tools", {
      data: { category: "Web", enabled: true },
    });
  }
});

test("/api/v1/builtin-tools rejects unknown categories", async ({ request }) => {
  const r = await request.patch("/api/v1/builtin-tools", {
    data: { category: "NotARealCategory", enabled: false },
  });
  expect(r.status()).toBe(400);
});
