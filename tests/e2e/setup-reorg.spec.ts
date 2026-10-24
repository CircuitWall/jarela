import { test, expect } from "@playwright/test";
import { dismissOverlayBanners, seedMockAgent, waitForAppReady } from "./helpers";

// Coverage for the menu reorganization (common vs. advanced tabs +
// new "Tools" entry), the per-agent persona in the Identity editor, and
// the structured memory preview.
//
// Tests in this file run serially: they all share one webServer (and
// therefore one JARELA_DB_DIR), so parallel writes to agent profiles
// from one test would race against state assertions in another.
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  const { agent } = await seedMockAgent(request);
  const reset = await request.put(`/api/v1/agents/${encodeURIComponent(agent)}`, {
    data: { usage_profile: "custom" },
  });
  expect(reset.ok()).toBeTruthy();
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

test("menu groups destinations and Capabilities hosts sub-tabs", async ({ page }) => {
  await openMenu(page);

  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  for (const label of ["Agents", "Settings", "Profile", "Usage", "Automations", "Knowledge"]) {
    await expect(navigation.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  await expect(navigation.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0);
  await navigation.locator("summary").filter({ hasText: "Advanced" }).click();
  await expect(navigation.getByRole("button", { name: "Capabilities", exact: true })).toBeVisible();

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

  // Click Capabilities to mount the full capability sub-tab strip.
  await page.getByRole("button", { name: "Capabilities", exact: true }).click();
  await expect(navigation).toHaveCount(0);
  const packagesTab = page.getByRole("tab", { name: "Packages", exact: true });
  await expect(packagesTab).toBeVisible();
  await expect(page.getByRole("tab", { name: "Documents", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Browser", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "MCP servers" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Bridges", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Knowledge", exact: true })).toHaveCount(0);
  await expect(packagesTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Packages", exact: true })).toBeVisible();

  // Knowledge is the shared search surface for documents and chat history.
  await openMenu(page);
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await expect(page.getByPlaceholder("Search documents and chats…")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Search channel" })).toBeVisible();
  await expect(page.locator("summary").getByText("Saved facts")).toBeVisible();
  await expect(page.locator("summary").getByText("Documents")).toBeVisible();
});

test("Settings panel exposes advanced sub-tabs when experience mode is full", async ({ page }) => {
  await openMenu(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();

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

test("legacy Documents URLs open the unified Knowledge search", async ({ page }) => {
  await page.goto("/?tab=documents");

  await expect(page.getByPlaceholder("Search documents and chats…")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
});

test("Knowledge search merges document and chat hits and filters by channel", async ({ page }) => {
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === "/api/v1/documents/search") {
        return Response.json({
          query: "deploy",
          min_similarity: 0.86,
          hits: [{
            document_id: "doc-1", source_id: "source-1", source_label: "Project", rel_path: "guide.md",
            abs_path: "", chunk_index: 0, text: "Deployment steps", score: 0.93, match: "semantic",
          }],
        });
      }
      if (url.pathname === "/api/v1/memory/search") {
        return Response.json({
          query: "deploy",
          source: "messages",
          min_chat_similarity: 0.84,
          hits: [{
            source: "message", thread_id: "thread-12345678", role: "user", content: "We chose the deployment plan.",
            score: 0.9, match: "semantic", created_at: "2026-10-09T00:00:00.000Z",
          }],
        });
      }
      return originalFetch(input, init);
    };
  });

  await openMenu(page);
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page.getByPlaceholder("Search documents and chats…").fill("deploy");
  await page.getByRole("button", { name: "Search", exact: true }).click();

  await expect(page.getByText("#1 · Documents · semantic")).toBeVisible();
  await expect(page.getByText("#2 · Chats · semantic")).toBeVisible();
  await expect(page.getByText("Deployment steps")).toBeVisible();
  await expect(page.getByText("We chose the deployment plan.")).toBeVisible();

  await page.getByRole("combobox", { name: "Search channel" }).selectOption("chats");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("We chose the deployment plan.")).toBeVisible();
  await expect(page.getByText("Deployment steps")).toHaveCount(0);
});

test("Agent persona picker round-trips through the API and reload", async ({ page, request }) => {
  const { agent } = await seedMockAgent(request);
  const agentUrl = `/api/v1/agents/${encodeURIComponent(agent)}`;
  const initialPreset = await request.put(agentUrl, { data: { usage_profile: "home" } });
  expect(initialPreset.ok()).toBeTruthy();
  await page.reload();
  await waitForAppReady(page);

  await openMenu(page);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.locator(`[data-deep-link-id="${agent}"]`).click();

  const persona = page.getByRole("group", { name: "Persona", exact: true });
  await expect(persona).toBeVisible();

  const homeBtn = persona.getByRole("button", { name: /^Home\b/ });
  await expect(homeBtn).toHaveAttribute("aria-pressed", "true");

  // Pick the "Work" preset.
  const workBtn = persona.getByRole("button", { name: /^Work\b/ });
  await workBtn.click();
  await expect(workBtn).toHaveAttribute("aria-pressed", "true");

  // Save and verify the API persisted it.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(persona).toBeHidden();

  const r = await request.get(agentUrl);
  expect(r.ok()).toBeTruthy();
  const body = await r.json() as { usage_profile: string };
  expect(body.usage_profile).toBe("work");
  await page.reload();
  await waitForAppReady(page);
  await page.locator(`[data-deep-link-id="${agent}"]`).click();
  await expect(persona.getByRole("button", { name: /^Work\b/ })).toHaveAttribute("aria-pressed", "true");
});

test("Credentials discovery follows the active agent persona, not the legacy profile", async ({ page, request }) => {
  const { agent } = await seedMockAgent(request);
  const put = await request.put(`/api/v1/agents/${encodeURIComponent(agent)}`, {
    data: { usage_profile: "home" },
  });
  expect(put.ok()).toBeTruthy();
  const legacy = await request.put("/api/v1/profile", { data: { preset: "work" } });
  expect(legacy.ok()).toBeTruthy();
  await page.reload();
  await waitForAppReady(page);

  // Credentials now lives as a sub-tab of Settings.
  await openMenu(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
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

  // The chip opens the active agent's Identity editor, not the user profile.
  await chip.click();
  const persona = page.getByRole("group", { name: "Persona", exact: true });
  await expect(persona).toBeVisible();
  await expect(persona.getByRole("button", { name: /^Home\b/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("E2E Mock");
});

test("memory previews show summaries, mask secrets, and open the full editor", async ({ page, request }) => {
  const seedNote = await request.put("/api/v1/memory/e2e-demo/note", {
    data: { value: "remember the milk" },
  });
  expect(seedNote.ok()).toBeTruthy();
  const seedCred = await request.put("/api/v1/memory/e2e-demo/connection", {
    data: { value: { url: "https://example.com", api_token: "ATATT-supersecret-xyz", email: "me@example.com" } },
  });
  expect(seedCred.ok()).toBeTruthy();
  const structured = {
    version: 2,
    subject: "Favorite editor",
    summary: "Prefers using VS Code",
    content: "The user prefers editing code in VS Code.",
  };
  const seedSummary = await request.put("/api/v1/memory/e2e-demo/editor", {
    data: { value: structured },
  });
  expect(seedSummary.ok()).toBeTruthy();

  await openMenu(page);
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();

  await page.locator("summary").filter({ hasText: "Saved facts" }).click();

  // Filter to our namespace so the list is bounded.
  await page.getByRole("combobox", { name: "Memory namespace" }).selectOption("e2e-demo");

  // Plain string renders without JSON quoting.
  await expect(page.getByText("remember the milk", { exact: true })).toBeVisible();

  // Secret-shaped fields stay masked in the preview.
  await expect(page.getByText("url:")).toBeVisible();
  await expect(page.getByText("api_token:")).toBeVisible();
  await expect(page.getByText("********").first()).toBeVisible();
  await expect(page.getByText("ATATT-supersecret-xyz")).toHaveCount(0);

  const summary = page.getByText(structured.summary, { exact: true });
  await expect(summary).toBeVisible();
  await expect(page.getByText("version:", { exact: true })).toHaveCount(0);
  await expect(page.getByText("subject:", { exact: true })).toHaveCount(0);
  await expect(page.getByText(structured.content, { exact: true })).toHaveCount(0);

  await summary.click();
  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Edit memory", exact: true }) });
  await expect(dialog).toBeVisible();
  const editor = dialog.getByRole("textbox", { name: "Value (JSON)" });
  await expect(editor).toHaveValue(JSON.stringify(structured, null, 2));
  const dialogBounds = await dialog.boundingBox();
  const editorBounds = await editor.boundingBox();
  expect(dialogBounds).not.toBeNull();
  expect(editorBounds).not.toBeNull();
  expect(dialogBounds!.width).toBeGreaterThanOrEqual(640);
  expect(editorBounds!.height).toBeGreaterThanOrEqual(await page.evaluate(() => innerHeight * 0.5));
  expect(await editor.evaluate((element) => getComputedStyle(element).resize)).toBe("vertical");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();

  // Cleanup so re-runs are deterministic.
  await request.delete("/api/v1/memory/e2e-demo/note");
  await request.delete("/api/v1/memory/e2e-demo/connection");
  await request.delete("/api/v1/memory/e2e-demo/editor");
});
