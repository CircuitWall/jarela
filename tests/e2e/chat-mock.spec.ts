import { test, expect } from "@playwright/test";
import { seedMockAgent, waitForAppReady } from "./helpers";
import type { ThreadDetail, ThreadSummary } from "@/api/types";

// Full chat round-trip using the mock provider — no LLM keys, fully
// deterministic. Validates: agent select → composer enabled → agent run →
// mock reply → rendered assistant message.

test.beforeEach(async ({ request }) => {
  await seedMockAgent(request);
});

for (const selectedThread of [false, true]) {
  test(`first agent load shares startup reads (${selectedThread ? "selected thread" : "default thread"})`, async ({ page, request }) => {
    const { agent } = await seedMockAgent(request);
    const threadResponse = await request.get(`/api/v1/agents/${agent}/thread`);
    expect(threadResponse.ok()).toBeTruthy();
    const thread = await threadResponse.json() as ThreadSummary;
    const paths = [
      "/api/v1/profile",
      `/api/v1/agents/${agent}`,
      `/api/v1/agents/${agent}/thread`,
      `/api/v1/threads/${thread.thread_id}`,
    ];
    const reads = new Map<string, number>();
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "GET" && paths.includes(url.pathname) && !url.search) {
        reads.set(url.pathname, (reads.get(url.pathname) ?? 0) + 1);
      }
    });
    await page.goto(selectedThread ? `/?agent=${agent}&thread=${thread.thread_id}` : "/");
    await waitForAppReady(page);
    await expect(page.getByPlaceholder("Message…")).toBeEnabled();
    // Boot and chat share the initial page. The idle stream's completion
    // deliberately requests one fresh page, rather than reusing startup data.
    await expect.poll(() => reads.get(paths[3])).toBe(2);
    for (const path of paths.slice(0, 2)) expect(reads.get(path), path).toBe(1);
    expect(reads.get(paths[2]) ?? 0).toBe(selectedThread ? 0 : 1);
  });
}

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

test("chat uses the available width and contains long tool content", async ({ page, request }) => {
  const { agent } = await seedMockAgent(request);
  const threadResponse = await request.get(`/api/v1/agents/${agent}/thread`);
  expect(threadResponse.ok()).toBeTruthy();
  const thread = await threadResponse.json() as ThreadSummary;
  const toolName = `workspace_${"long_tool_name_".repeat(12)}`;
  const longKey = `argument_${"key".repeat(80)}`;
  const longValue = "value".repeat(120);
  await page.route((url) => url.pathname === `/api/v1/threads/${thread.thread_id}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const detail = await response.json() as ThreadDetail;
    await route.fulfill({
      response,
      json: {
        ...detail,
        has_more: false,
        messages: [
          {
            id: "layout-user", seq: 1, role: "user", content: "Layout check",
            created_at: "2026-10-18T08:00:00.000Z",
          },
          {
            id: "layout-assistant", seq: 2, role: "assistant",
            content: "A detailed answer uses the available conversation width. ".repeat(12),
            created_at: "2026-10-18T08:00:01.000Z",
            tool_events: [
              { id: "layout-done", phase: "call", name: toolName, payload: { [longKey]: { [longKey]: longValue } } },
              { id: "layout-done", phase: "result", name: toolName, payload: { ok: true } },
              { id: "layout-running", phase: "call", name: "local_exec", payload: { command: longValue } },
            ],
          },
        ],
      },
    });
  });

  await page.goto(`/?agent=${agent}&thread=${thread.thread_id}`);
  await waitForAppReady(page);
  const assistant = page.locator('[data-message-id="layout-assistant"]');
  const tool = assistant.getByRole("button", { name: new RegExp(toolName) });
  await expect(tool).toBeVisible();
  await tool.click();

  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => {
      return assistant.evaluate((row) => {
        const bubble = row.querySelector(".glass-bubble");
        const column = bubble?.parentElement;
        if (!column) return null;
        // The avatar is 28px wide, with an 8px gap to the content column.
        return Math.abs(row.getBoundingClientRect().width - column.getBoundingClientRect().width - 36);
      });
    }).toBeLessThanOrEqual(1);
    const metrics = await assistant.evaluate((row) => {
      const nodes = row.querySelectorAll("button[aria-expanded], button[aria-expanded] > span, dl, dt, dd, [role='progressbar'], [aria-label='succeeded']");
      return Array.from(nodes).map((node) => {
        const bounds = node.getBoundingClientRect();
        const pill = node.closest("button[aria-expanded]");
        const parent = (pill ?? row).getBoundingClientRect();
        return {
          tag: node.tagName,
          leftOverflow: parent.left - bounds.left,
          rightOverflow: bounds.right - parent.right,
          contentOverflow: node.clientWidth > 0 ? node.scrollWidth - node.clientWidth : 0,
          truncated: getComputedStyle(node).textOverflow === "ellipsis",
        };
      });
    });
    expect(metrics.length).toBeGreaterThan(5);
    for (const metric of metrics) {
      expect(metric.leftOverflow, JSON.stringify(metric)).toBeLessThanOrEqual(1);
      expect(metric.rightOverflow, JSON.stringify(metric)).toBeLessThanOrEqual(1);
      if (!metric.truncated) expect(metric.contentOverflow, JSON.stringify(metric)).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const send = await page.getByRole("button", { name: "Send", exact: true }).boundingBox();
    expect(send).not.toBeNull();
    expect(send!.x + send!.width).toBeLessThanOrEqual(width);
  }
});
