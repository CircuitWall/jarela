import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

// Coverage for the menu reorganization (common vs. advanced tabs +
// new "Tools" entry), the persona preset on the Profile editor, and
// the structured memory preview.
//
// Tests in this file run serially: they all share one webServer (and
// therefore one JARELA_DB_DIR), so parallel writes to /api/v1/profile
// from one test would race against state assertions in another.
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  // Reset the profile preset so the Connections-chip + Profile-preset
  // tests don't bleed into each other (or into reruns).
  await request.put("/api/v1/profile", { data: { preset: null } });
  // CI runs without an OS keychain, so the at-rest crypto bootstrap falls
  // back to a keyfile and surfaces a fixed banner that covers the menu
  // panel and intercepts clicks on tabs underneath. Pre-dismiss it so
  // tests can interact with the UI without flakiness. Must seed the
  // localStorage flag on the target origin before navigating.
  await page.addInitScript(() => {
    try { localStorage.setItem("jarela:crypto-fallback-banner-dismissed", "1"); } catch { /* sandbox */ }
    // Seed advanced experience mode so the Advanced section renders in
    // the menu panel (gated in AppShell.tsx + MenuPanel.tsx).
    try { localStorage.setItem("jarela.experience.mode", "full"); } catch { /* sandbox */ }
  });
  await page.goto("/");
  await expect(page.getByPlaceholder("Message…")).toBeVisible({ timeout: 15_000 });
});

async function openMenu(page: import("@playwright/test").Page) {
  const menuToggle = page
    .locator("header button")
    .filter({ has: page.locator("svg") })
    .last();
  await menuToggle.click();
  await expect(page.locator(".glass-elevated.fixed").first()).toBeVisible();
}

test("menu separates common from advanced and Tools hosts capability sub-tabs", async ({ page }) => {
  await openMenu(page);

  // Common tabs visible up top (MenuPanel.COMMON_TABS). Capability surfaces
  // (Documents, Memory, Bridges, MCP, Extensions) now live under Tools, and
  // Models moved to Advanced.
  for (const label of ["Chat", "Dashboard", "Agents", "Tools", "Connections", "Tasks", "Profile"]) {
    await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
  }

  // Documents / Memory / Bridges are no longer top-level buttons in the menu.
  await expect(page.getByRole("button", { name: "Documents", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Memory", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Bridges", exact: true })).toHaveCount(0);

  // Advanced header is rendered with the canonical label.
  const advancedHeader = page.getByRole("button", { name: /^Advanced$/i });
  await expect(advancedHeader).toBeVisible();
  await expect(advancedHeader).toHaveAttribute("aria-expanded", "true");

  // Advanced tabs visible — Models, Harness, Logs, Defaults (MenuPanel.ADVANCED_TABS).
  await expect(page.getByRole("button", { name: "Models", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Harness", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Defaults", exact: true })).toBeVisible();

  // Click Tools → ToolsPanel mounts with the full capability sub-tab strip.
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  const builtinTab = page.getByRole("tab", { name: "Built-in", exact: true });
  await expect(builtinTab).toBeVisible();
  await expect(page.getByRole("tab", { name: "Documents", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Memory", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "MCP servers" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Browser extension" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Bridges", exact: true })).toBeVisible();
  await expect(builtinTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Built-in tools" })).toBeVisible();

  // Switch to Documents sub-tab → DocumentsPanel renders inside the Tools surface.
  await page.getByRole("tab", { name: "Documents", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Documents", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("Advanced section collapses and remembers state via localStorage", async ({ page }) => {
  await openMenu(page);
  const advancedHeader = page.getByRole("button", { name: /^Advanced$/i });
  const modelsBtn = page.getByRole("button", { name: "Models", exact: true });

  // Initially expanded.
  await expect(advancedHeader).toHaveAttribute("aria-expanded", "true");
  await expect(modelsBtn).toBeVisible();

  // Collapse → hides advanced tabs and persists "0".
  await advancedHeader.click();
  await expect(advancedHeader).toHaveAttribute("aria-expanded", "false");
  await expect(modelsBtn).toBeHidden();
  const persisted = await page.evaluate(() => window.localStorage.getItem("jarela.menu.advanced"));
  expect(persisted).toBe("0");

  // Reload → still collapsed.
  await page.reload();
  await expect(page.getByPlaceholder("Message…")).toBeVisible({ timeout: 15_000 });
  await openMenu(page);
  await expect(page.getByRole("button", { name: /^Advanced$/i })).toHaveAttribute("aria-expanded", "false");
});

test("Profile preset picker round-trips through the API", async ({ page, request }) => {
  await openMenu(page);
  await page.getByRole("button", { name: "Profile", exact: true }).click();

  // Persona section heading.
  await expect(page.getByText(/Filters the Connections panel/i)).toBeVisible();

  // Pick the "Work" preset.
  const workBtn = page.getByRole("button", { name: /^Work\b/ });
  await workBtn.click();
  await expect(workBtn).toHaveAttribute("aria-pressed", "true");

  // Save and verify the API persisted it.
  await page.getByRole("button", { name: /^Save profile$/ }).click();
  await expect(page.getByRole("button", { name: /^Saved$/ })).toBeVisible();

  const r = await request.get("/api/v1/profile");
  expect(r.ok()).toBeTruthy();
  const body = await r.json() as { preset?: string | null };
  expect(body.preset).toBe("work");
});

test("Connections panel filter chip reflects the active preset", async ({ page, request }) => {
  // Pre-set the preset via the API so the panel renders with it on first paint.
  const put = await request.put("/api/v1/profile", { data: { preset: "home" } });
  expect(put.ok()).toBeTruthy();

  await openMenu(page);
  await page.getByRole("button", { name: "Connections", exact: true }).click();

  // Header chip shows the human label and is clickable.
  const chip = page.getByRole("button", { name: /^Home/ });
  await expect(chip).toBeVisible();

  // Home preset hides issue-tracker integrations (Atlassian, Jira Align)
  // and infrastructure (GitHub) when they aren't configured. Their card
  // headings shouldn't be in the DOM.
  await expect(page.getByRole("heading", { name: /Atlassian/ })).toHaveCount(0);
  // exact: "GitHub Copilot" is an LLM integration allowed under home.
  await expect(page.getByRole("heading", { name: "GitHub", exact: true })).toHaveCount(0);

  // Click chip → navigates to Profile.
  await chip.click();
  await expect(page.getByText(/Filters the Connections panel/i)).toBeVisible();
});

test("memory panel renders structured values and masks secret-shaped keys", async ({ page, request }) => {
  // Seed two memory entries: one plain note, one credential-shaped blob.
  const seedNote = await request.put("/api/v1/memory/e2e-demo/note", {
    data: { value: "remember the milk" },
  });
  expect(seedNote.ok()).toBeTruthy();
  const seedCred = await request.put("/api/v1/memory/e2e-demo/connection", {
    data: { value: { url: "https://example.com", api_token: "ATATT-supersecret-xyz", email: "me@example.com" } },
  });
  expect(seedCred.ok()).toBeTruthy();

  await openMenu(page);
  await page.getByRole("button", { name: "Memory", exact: true }).click();

  // Filter to our namespace so the list is bounded.
  await page.getByRole("combobox").selectOption("e2e-demo");

  // Plain string renders without JSON quoting.
  await expect(page.getByText("remember the milk", { exact: true })).toBeVisible();

  // Object renders as key chips with the secret masked, and the literal
  // token must NEVER appear anywhere in the rendered DOM.
  await expect(page.getByText("url:")).toBeVisible();
  await expect(page.getByText("api_token:")).toBeVisible();
  await expect(page.getByText("********").first()).toBeVisible();
  await expect(page.getByText("ATATT-supersecret-xyz")).toHaveCount(0);

  // Expand the connection row's chevron → pretty-printed JSON, still masked.
  const expandBtn = page.locator('button[aria-expanded="false"]', { hasText: "api_token:" }).first();
  await expandBtn.click();
  const block = page.locator("pre").filter({ hasText: '"api_token"' }).first();
  await expect(block).toBeVisible();
  await expect(block).toContainText("********");
  await expect(block).not.toContainText("supersecret");

  // Cleanup so re-runs are deterministic.
  await request.delete("/api/v1/memory/e2e-demo/note");
  await request.delete("/api/v1/memory/e2e-demo/connection");
});
