import { test, expect } from "@playwright/test";
import { dismissOverlayBanners, seedMockAgent, waitForAppReady } from "./helpers";

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
  // Reset the profile preset so the persona-chip + Profile-preset
  // tests don't bleed into each other (or into reruns).
  await request.put("/api/v1/profile", { data: { preset: null } });
  // CI runs without an OS keychain, so the at-rest crypto bootstrap falls
  // back to a keyfile and surfaces a fixed banner that covers the menu
  // panel and intercepts clicks on tabs underneath. The OS-notification
  // banner sits in the same y-band on headless chromium (Notification
  // permission == "denied"). Dismiss both before navigation so tests can
  // interact with the UI without flakiness.
  await dismissOverlayBanners(page);
  await page.addInitScript(() => {
    // Seed advanced experience mode so the Settings sub-tabs flagged
    // advancedOnly (Test runs / Logs / Environment) render in tests.
    try { localStorage.setItem("jarela.experience.mode", "full"); } catch { /* sandbox */ }
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

test("menu separates common from advanced and Tools hosts capability sub-tabs", async ({ page }) => {
  await openMenu(page);

  // Common tabs visible up top (MenuPanel.COMMON_TABS). Capability surfaces
  // (Documents, Memory, Bridges, MCP, Extensions) live under Tools, and the
  // former Credentials/Models/Test-runs/Logs/Environment entries are now sub-tabs
  // of the consolidated Settings panel.
  for (const label of ["Chat", "Dashboard", "Agents", "Tools", "Tasks", "Profile", "Advanced settings"]) {
    await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
  }

  // These are no longer top-level buttons in the menu.
  for (const label of [
    "Documents",
    "Memory",
    "Bridges",
    "Connections",
    "Credentials",
    "Models",
    "Test runs",
    "Logs",
    "Environment",
  ]) {
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  }

  // Click Tools → ToolsPanel mounts with the full capability sub-tab strip.
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  const packagesTab = page.getByRole("tab", { name: "Packages", exact: true });
  await expect(packagesTab).toBeVisible();
  await expect(page.getByRole("tab", { name: "Documents", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Memory", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "MCP servers" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Bridges", exact: true })).toBeVisible();
  await expect(packagesTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Packages", exact: true })).toBeVisible();

  // Switch to Documents sub-tab → DocumentsPanel renders inside the Tools surface.
  await page.getByRole("tab", { name: "Documents", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Documents", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("Settings panel exposes advanced sub-tabs when experience mode is full", async ({ page }) => {
  await openMenu(page);
  await page.getByRole("button", { name: "Advanced settings", exact: true }).click();

  // Always-visible sub-tabs.
  for (const label of ["Credentials", "Models", "Privacy & security", "Appearance", "Networking"]) {
    await expect(page.getByRole("tab", { name: label, exact: true })).toBeVisible();
  }
  // Full experience mode (seeded in beforeEach) reveals these advanced-only tabs.
  for (const label of ["Logs", "Environment"]) {
    await expect(page.getByRole("tab", { name: label, exact: true })).toBeVisible();
  }
  // Test runs / Harnesses moved to Agents panel.
  await expect(page.getByRole("tab", { name: "Test runs", exact: true })).toHaveCount(0);
});

test("Profile preset picker round-trips through the API", async ({ page, request }) => {
  await openMenu(page);
  await page.getByRole("button", { name: "Profile", exact: true }).click();

  // Persona section heading.
  await expect(page.getByText(/Filters the Credentials list/i)).toBeVisible();

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

test("Credentials list filter chip reflects the active preset", async ({ page, request }) => {
  // Pre-set the preset via the API so the panel renders with it on first paint.
  const put = await request.put("/api/v1/profile", { data: { preset: "home" } });
  expect(put.ok()).toBeTruthy();

  // Credentials now lives as a sub-tab of the Advanced settings surface.
  await openMenu(page);
  await page.getByRole("button", { name: "Advanced settings", exact: true }).click();
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();

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
  await expect(page.getByText(/Filters the Credentials list/i)).toBeVisible();
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
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("tab", { name: "Memory", exact: true }).click();

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
