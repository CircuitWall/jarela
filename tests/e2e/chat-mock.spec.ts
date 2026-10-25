import { test, expect } from "@playwright/test";
import { seedMockAgent, waitForAppReady } from "./helpers";
import type { ThreadDetail, ThreadSummary } from "@/api/types";
import { readFile } from "node:fs/promises";

// Full chat round-trip using the mock provider — no LLM keys, fully
// deterministic. Validates: agent select → composer enabled → agent run →
// mock reply → rendered assistant message.

test.beforeEach(async ({ request }) => {
  await seedMockAgent(request);
});

test("mermaid use-case diagrams expose source and download a standalone SVG", async ({ page, request }) => {
  const { agent } = await seedMockAgent(request);
  const response = await request.get(`/api/v1/agents/${agent}/thread`);
  expect(response.ok()).toBeTruthy();
  const thread = await response.json() as ThreadSummary;
  const source = "usecase-beta\n  actor User\n  Login(Sign in)\n  User --> Login";
  await page.route((url) => url.pathname === `/api/v1/threads/${thread.thread_id}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const detail = await response.json() as ThreadDetail;
    await route.fulfill({
      response,
      json: {
        ...detail,
        has_more: false,
        messages: [{
          id: "mermaid-export", seq: 1, role: "assistant",
          content: `\`\`\`mermaid\n${source}\n\`\`\``,
          created_at: "2026-10-25T08:00:00.000Z",
        }],
      },
    });
  });
  await page.goto(`/?agent=${agent}&thread=${thread.thread_id}`);
  await waitForAppReady(page);
  await expect(page.getByRole("img", { name: "Mermaid diagram" })).toBeVisible({ timeout: 20_000 });
  await page.getByText("Diagram source", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy code" })).toBeVisible();
  const pendingDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download diagram as SVG" }).click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toBe("diagram.svg");
  const path = await download.path();
  expect(path).toBeTruthy();
  const svg = await readFile(path!, "utf8");
  expect(svg).toContain("<svg");
  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(svg).not.toMatch(/<script\b|\bonclick=/i);
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
      const transcriptDelta = url.pathname === paths[3] && url.searchParams.has("after");
      if (request.method() === "GET" && paths.includes(url.pathname) && (!url.search || transcriptDelta)) {
        reads.set(url.pathname, (reads.get(url.pathname) ?? 0) + 1);
      }
    });
    await page.goto(selectedThread ? `/?agent=${agent}&thread=${thread.thread_id}` : "/");
    await waitForAppReady(page);
    await expect(page.getByPlaceholder("Message…")).toBeEnabled();
    // Boot and chat share the initial page. Idle completion requests fresh
    // data, optionally using an after cursor when confirmed rows are available.
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
  const sendButton = page.getByRole("button", { name: "Send", exact: true })
    .within(page.locator(".chat-composer"));
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

  // The mock provider streams the marker back; assert it lands in the
  // rendered message list. Use .last() because the marker also appears
  // inside the user-message bubble that echoes "MOCK:reply=<marker>".
  await expect(page.getByText(marker).last()).toBeVisible({ timeout: 20_000 });
});

test("ordinary summaries survive streaming, persistence, and reload without a correction retry", async ({ page, request }) => {
  const { agent } = await seedMockAgent(request);
  const response = await request.get(`/api/v1/agents/${agent}/thread`);
  expect(response.ok()).toBeTruthy();
  const thread = await response.json() as ThreadSummary;
  const marker = `summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const heading = `Summary ${marker}: A costs 10; B costs 20; C costs 30; D costs 40; E costs 50.`;
  const reply = `## ${heading}`;
  await page.goto(`/?agent=${agent}&thread=${thread.thread_id}`);
  await waitForAppReady(page);
  await page.getByPlaceholder("Message…").fill(`Compare the five options.\nMOCK:reply=${reply}\nMOCK:slow=15`);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await expect.poll(async () => {
    const transcript = await request.get(`/api/v1/threads/${thread.thread_id}`);
    expect(transcript.ok()).toBeTruthy();
    const detail = await transcript.json() as ThreadDetail;
    const message = detail.messages.find((row) => row.role === "assistant" && row.content === reply);
    return message?.transcript_status;
  }, { timeout: 20_000 }).toBe("completed");
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await page.reload();
  await waitForAppReady(page);
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
});

test("stopping a slow stream persists an interrupted partial answer across reload", async ({ page, request }) => {
  const { agent } = await seedMockAgent(request);
  const response = await request.get(`/api/v1/agents/${agent}/thread`);
  expect(response.ok()).toBeTruthy();
  const thread = await response.json() as ThreadSummary;
  const marker = `stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const finalMarker = `${marker}-finished`;
  const reply = `${marker} ${"streaming-word ".repeat(80)}${finalMarker}`;
  await page.goto(`/?agent=${agent}&thread=${thread.thread_id}`);
  await waitForAppReady(page);
  await page.getByPlaceholder("Message…").fill(`Stream the scripted answer slowly.\nMOCK:reply=${reply}\nMOCK:slow=100`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => {
    const transcript = await request.get(`/api/v1/threads/${thread.thread_id}`);
    expect(transcript.ok()).toBeTruthy();
    const detail = await transcript.json() as ThreadDetail;
    return detail.messages.some((row) => row.role === "assistant" && String(row.content).includes(marker));
  }).toBe(true);
  await page.getByRole("button", { name: "Stop", exact: true }).click();

  let messageId = "";
  await expect.poll(async () => {
    const transcript = await request.get(`/api/v1/threads/${thread.thread_id}`);
    expect(transcript.ok()).toBeTruthy();
    const detail = await transcript.json() as ThreadDetail;
    const message = detail.messages.find((row) => row.role === "assistant" && String(row.content).includes(marker));
    messageId = message?.id ?? "";
    if (message?.transcript_status === "interrupted") {
      expect(String(message.content)).toContain("Interrupted by user");
      expect(String(message.content)).not.toContain(finalMarker);
    }
    return message?.transcript_status;
  }, { timeout: 15_000 }).toBe("interrupted");
  await page.reload();
  await waitForAppReady(page);
  const message = page.locator(`[data-message-id="${messageId}"]`);
  await expect(message).toContainText(marker);
  await expect(message).toContainText("Interrupted by user");
  await expect(message).not.toContainText(finalMarker);
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
