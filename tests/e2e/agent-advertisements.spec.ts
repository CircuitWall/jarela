import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { dismissOverlayBanners, seedMockAgent } from "./helpers";
import { isBasicToolCategory } from "../../lib/tools/runtime/categories";

const endpoint = "/api/v1/agent-advertisements";
// Mirrors lib/tools/runtime/catalog.ts: Basic-category tools excluded from implicit grants.
const DEFAULT_EXCLUDED_BASIC_TOOL_NAMES = new Set(["terminal_open", "terminal_exec", "terminal_send", "terminal_read", "terminal_close", "terminal_list"]);
type Policy = {
  enabled: boolean; model_config_name: string | null; max_calls_per_hour: number;
  max_input_chars: number; max_output_tokens: number; timeout_ms: number;
};
type Snapshot = {
  policy: Policy;
  advertisement: {
    agent_id: string; generation_id?: string; status: string; enabled: boolean; error: string | null;
    source_fingerprint: string; policy_fingerprint: string; updated_at: string; advertisement: unknown;
  } | null;
};
const defaultPolicy: Policy = {
  enabled: false, model_config_name: null, max_calls_per_hour: 10,
  max_input_chars: 16000, max_output_tokens: 1024, timeout_ms: 30000,
};

test.describe.configure({ mode: "serial" });

test("advertisement API returns the uncached global policy contract", async ({ request }) => {
  const response = await request.get(endpoint);
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const body = await response.json() as Snapshot;
  expect(body.advertisement).toBeNull();
  expect(Object.keys(body.policy).sort()).toEqual(Object.keys(defaultPolicy).sort());
});

test.describe("runner-owned advertisement mutations", () => {
  // The PWA worker can satisfy refetches outside page.route; keep request evidence observable.
  test.use({ serviceWorkers: "block" });
  test.skip(!!process.env.JARELA_E2E_BASE_URL, "Global advertisement policy and agent writes require the runner-owned isolated app");
  let agentId = "";
  let agentName = "";
  let modelName = "";

  test.beforeEach(async ({ request, page }, testInfo) => {
    modelName = (await seedMockAgent(request)).model;
    await putPolicy(request, defaultPolicy);
    agentName = `E2E Advertisement ${testInfo.retry}-${Date.now()}`;
    const created = await request.post("/api/v1/agents", {
      data: {
        name: agentName, identity: "A disposable advertisement browser fixture.",
        instructions: "Do nothing; this fixture only verifies operator controls.", tools: [],
        model_config_name: modelName, is_default: false,
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    agentId = ((await created.json()) as { id: string }).id;
    await dismissOverlayBanners(page);
  });

  test.afterEach(async ({ request }) => {
    await putPolicy(request, defaultPolicy);
    if (agentId) expect((await request.delete(`/api/v1/agents/${encodeURIComponent(agentId)}`)).ok()).toBe(true);
    agentId = "";
  });

  test("new agents must be saved before the advertisement API is used", async ({ page }) => {
    const requests = trackAdvertisementRequests(page);
    await page.goto("/?tab=agents");
    const workspace = page.getByTestId("workspace-content");
    await workspace.getByRole("button", { name: "New", exact: true }).click();
    const dialog = editorDialog(page, "New agent");
    await expect(dialog.getByText("Save this agent first to manage its advertisement.")).toBeVisible();
    await expect(dialog.getByText(/committed identity and instructions/)).toContainText("Conversations and credentials are not included");
    await expect(dialog.getByText(/model-generated claims/)).toContainText("grant no permissions");
    await expect(dialog.getByRole("button", { name: "Regenerate advertisement" })).toHaveCount(0);
    expect(requests).toEqual([]);
  });

  test("saved agent shows disabled defaults and refuses enabling without a named model", async ({ page, request }) => {
    const requests = trackAdvertisementRequests(page);
    const dialog = await openSavedAgent(page);
    await expect(dialog.getByText("Status: disabled")).toBeVisible();
    await expect(dialog.getByText("Global generation is disabled.")).toBeVisible();
    await expect(dialog.getByLabel("Enable advertisement generation globally")).not.toBeChecked();
    await expect(dialog.getByLabel("Generation model (explicit named selection)")).toHaveValue("");
    await expect(dialog.getByLabel("Maximum calls per hour")).toHaveValue("10");
    await expect(dialog.getByLabel("Maximum input characters")).toHaveValue("16000");
    await expect(dialog.getByLabel("Maximum output tokens")).toHaveValue("1024");
    await expect(dialog.getByLabel("Generation timeout (ms)")).toHaveValue("30000");
    await expect(dialog.locator("option", { hasText: `${modelName} (mock / mock-1)` })).toHaveCount(1);
    await expect(dialog.getByText("Source fingerprint")).toBeVisible();
    await expect(dialog.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);

    await dialog.getByLabel("Enable advertisement generation globally").check();
    await expect(dialog.getByText("Choose an enabled configured model by name; there is no automatic fallback.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save generation settings" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Regenerate advertisement" })).toBeDisabled();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((entry) => entry.method !== "GET")).toEqual([]);
    expect(requests.every((entry) => entry.url.endsWith(`${endpoint}?agent_id=${encodeURIComponent(agentId)}`))).toBe(true);

    const refused = await request.put(endpoint, { data: { policy: { ...defaultPolicy, enabled: true, model_config_name: "missing-e2e-model" } } });
    expect(refused.status()).toBe(400);
    expect((await getSnapshot(request, agentId)).policy).toEqual(defaultPolicy);
  });

  test("per-agent disable, enable and regenerate stay inert while generation is disabled", async ({ page, request }) => {
    const requests = trackAdvertisementRequests(page);
    const dialog = await openSavedAgent(page);
    await expect(dialog.getByText("Status: disabled")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Regenerate advertisement" })).toBeDisabled();

    await dialog.getByRole("button", { name: "Disable advertisement" }).click();
    await expect(dialog.getByText("Advertisement disabled.")).toBeVisible();
    await expect(dialog.getByText("Per-agent advertisement: disabled")).toBeVisible();
    await dialog.getByRole("button", { name: "Enable advertisement" }).click();
    await expect(dialog.getByText("Advertisement enabled.")).toBeVisible();
    await expect(dialog.getByText("Per-agent advertisement: enabled")).toBeVisible();
    await expect(dialog.getByText("Status: disabled")).toBeVisible();
    expect(requests.filter((entry) => entry.method === "POST").map((entry) => entry.body)).toEqual([
      { agent_id: agentId, action: "disable" },
      { agent_id: agentId, action: "enable" },
    ]);

    const regenerated = await request.post(endpoint, { data: { agent_id: agentId, action: "regenerate" } });
    expect(regenerated.ok(), await regenerated.text()).toBe(true);
    expect((await regenerated.json() as Snapshot).advertisement).toMatchObject({
      agent_id: agentId, status: "disabled", enabled: true, error: null, advertisement: null, source_fingerprint: "",
    });
    await page.waitForTimeout(250);
    expect((await getSnapshot(request, agentId)).advertisement).toMatchObject({ status: "disabled", error: null, advertisement: null });

    await dialog.getByRole("button", { name: "Refresh advertisement" }).click();
    await expect(dialog.getByText("Status: disabled")).toBeVisible();
    expect(requests.filter((entry) => entry.method === "PUT")).toEqual([]);
  });

  test("named mock policy surfaces invalid generated output as a failed state", async ({ page, request }) => {
    await putPolicy(request, { ...defaultPolicy, enabled: true, model_config_name: modelName, max_calls_per_hour: 100 });
    const regenerated = await request.post(endpoint, { data: { agent_id: agentId, action: "regenerate" } });
    expect(regenerated.ok(), await regenerated.text()).toBe(true);
    expect(["pending", "failed"]).toContain((await regenerated.json() as Snapshot).advertisement?.status);
    await expect.poll(async () => (await getSnapshot(request, agentId)).advertisement?.status, { timeout: 15_000 }).toBe("failed");
    const failed = (await getSnapshot(request, agentId)).advertisement!;
    expect(failed.error).toEqual(expect.any(String));
    expect(failed.advertisement).toBeNull();
    expect(failed.source_fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const dialog = await openSavedAgent(page);
    await expect(dialog.getByText("Status: failed")).toBeVisible();
    await expect(dialog.getByText(`Generation error: ${failed.error}`)).toBeVisible();
    await expect(dialog.getByLabel("Read-only generated advertisement")).toHaveCount(0);
    await expect(dialog.getByText(failed.source_fingerprint)).toBeVisible();
  });

  test("pending UI polls the production API until the real disabled state is returned", async ({ page }) => {
    let intercepted = 0;
    const requests = trackAdvertisementRequests(page);
    await page.route((url) => url.pathname === endpoint && url.searchParams.get("agent_id") === agentId, async (route) => {
      if (route.request().method() !== "GET" || intercepted++ > 0) return route.continue();
      await route.fulfill({ json: {
        policy: { ...defaultPolicy, enabled: true, model_config_name: modelName },
        advertisement: {
          version: 1, generation_id: "pending-fixture", agent_id: agentId, status: "pending", enabled: true,
          source_fingerprint: "a".repeat(64), policy_fingerprint: "b".repeat(64),
          updated_at: "2026-10-30T12:00:00.000Z", error: null, advertisement: null,
        },
      }, headers: { "cache-control": "no-store" } });
    });
    await page.goto("/?tab=agents");
    await page.getByTestId("workspace-content").getByText(agentName, { exact: true }).filter({ visible: true }).click();
    const dialog = editorDialog(page, "Edit agent");
    await expect(dialog.getByText("Status: pending")).toBeVisible();
    await expect(dialog.getByText("Generation pending. Status refreshes automatically.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Regenerate advertisement" })).toBeDisabled();
    await expect(dialog.getByText("Status: disabled")).toBeVisible({ timeout: 8_000 });
    expect(intercepted).toBeGreaterThanOrEqual(2);
    expect(requests.filter((entry) => entry.method !== "GET")).toEqual([]);
  });
  async function openSavedAgent(page: Page) {
    await page.goto("/?tab=agents");
    const workspace = page.getByTestId("workspace-content");
    await workspace.getByText(agentName, { exact: true }).filter({ visible: true }).click();
    const dialog = editorDialog(page, "Edit agent");
    await expect(dialog.getByText("Agent advertisement", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Enable advertisement generation globally")).toBeEnabled();
    return dialog;
  }
});

test.describe("runner-owned deterministic advertisement fixture", () => {
  test.skip(!!process.env.JARELA_E2E_BASE_URL, "Global advertisement policy, model and agent writes require the runner-owned isolated app");
  const fixture = {
    purpose: "Review synthetic fixtures", call_when: ["A synthetic fixture needs a concise review"],
    do_not_call_for: ["Unrelated operational changes"], inputs: "Synthetic fixture text",
    output: "A checked plain-language summary", tools: [],
  };
  const privateMarker = "PRIVATE-ADVERTISEMENT-SOURCE-MARKER";
  let agentId = "";
  let agentName = "";
  let modelName = "";

  test.beforeEach(async ({ request, page }) => {
    await seedMockAgent(request);
    await putPolicy(request, defaultPolicy);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    modelName = `e2e-advertisement-fixture-${suffix}`;
    const model = await request.post("/api/v1/models", {
      data: { name: modelName, provider: "mock", model_id: "mock-advertisement-fixture", params: {}, is_default: false },
    });
    expect(model.ok(), await model.text()).toBe(true);
    agentName = `E2E Advertisement Fixture ${suffix}`;
    const created = await request.post("/api/v1/agents", {
      data: {
        name: agentName, identity: `Synthetic identity ${privateMarker}`,
        instructions: `Synthetic instructions ${privateMarker}`, tools: [],
        model_config_name: modelName, is_default: false,
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    agentId = ((await created.json()) as { id: string }).id;
    await putPolicy(request, { ...defaultPolicy, enabled: true, model_config_name: modelName, max_calls_per_hour: 100 });
    await dismissOverlayBanners(page);
  });

  test.afterEach(async ({ request }) => {
    const failures: string[] = [];
    const policy = await request.put(endpoint, { data: { policy: defaultPolicy } });
    if (!policy.ok()) failures.push(`policy ${policy.status()} ${await policy.text()}`);
    if (agentId) {
      const agent = await request.delete(`/api/v1/agents/${encodeURIComponent(agentId)}`);
      if (!agent.ok()) failures.push(`agent ${agent.status()} ${await agent.text()}`);
    }
    if (modelName) {
      const model = await request.delete(`/api/v1/models/${encodeURIComponent(modelName)}`);
      if (!model.ok()) failures.push(`model ${model.status()} ${await model.text()}`);
    }
    agentId = "";
    modelName = "";
    expect(failures).toEqual([]);
  });

  test("named fixture model produces a ready, read-only advertisement in the editor", async ({ page, request }) => {
    const ready = await regenerateUntilReady(request, agentId);
    expect(ready.advertisement).toEqual(fixture);
    expect(ready.error).toBeNull();
    expect(ready.source_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(ready.policy_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(ready.advertisement)).not.toContain(privateMarker);

    await page.goto("/?tab=agents");
    await page.getByTestId("workspace-content").getByText(agentName, { exact: true }).filter({ visible: true }).click();
    const dialog = editorDialog(page, "Edit agent");
    await expect(dialog.getByText("Status: ready")).toBeVisible();
    await expect(dialog.getByText("Ready means generated, not verified.")).toBeVisible();
    await expect(dialog.getByText(ready.source_fingerprint, { exact: true })).toBeVisible();
    await expect(dialog.getByText(ready.policy_fingerprint, { exact: true })).toBeVisible();
    const generated = dialog.getByLabel("Read-only generated advertisement");
    for (const text of [fixture.purpose, ...fixture.call_when, ...fixture.do_not_call_for, fixture.inputs, fixture.output]) {
      await expect(generated.getByText(text, { exact: true })).toBeVisible();
    }
    await expect(generated.getByText("None listed", { exact: true })).toBeVisible();
    await expect(generated.locator("input, textarea, select, button, [contenteditable='true']")).toHaveCount(0);
    await expect(generated).not.toContainText(privateMarker);
  });

  test("committed source changes revise the fingerprint before regenerated output", async ({ request }) => {
    const first = await regenerateUntilReady(request, agentId);
    const updated = await request.put(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
      data: { instructions: `Revised synthetic instructions ${privateMarker}` },
    });
    expect(updated.ok(), await updated.text()).toBe(true);
    const revised = await regenerateUntilReady(request, agentId);
    expect(revised.source_fingerprint).not.toBe(first.source_fingerprint);
    expect(revised.policy_fingerprint).toBe(first.policy_fingerprint);
    expect(revised.advertisement).toEqual(fixture);

    const catalog = await request.get("/api/v1/tools");
    expect(catalog.ok(), await catalog.text()).toBe(true);
    const optionalTool = ((await catalog.json()) as Array<{ name: string; status: string; category: string | null }>)
      .find((tool) => tool.status === "enabled"
        && (!isBasicToolCategory(tool.category) || DEFAULT_EXCLUDED_BASIC_TOOL_NAMES.has(tool.name)));
    expect(optionalTool, "isolated app must expose an enabled tool that requires explicit agent authorization").toBeTruthy();
    const tools = await request.put(`/api/v1/agents/${encodeURIComponent(agentId)}`, { data: { tools: [optionalTool!.name] } });
    expect(tools.ok(), await tools.text()).toBe(true);
    const permitted = await regenerateUntilReady(request, agentId);
    expect(permitted.source_fingerprint).not.toBe(revised.source_fingerprint);
    expect(permitted.advertisement).toEqual(fixture);
  });

  test("ten forced regenerations each complete with the deterministic fixture", async ({ request }) => {
    test.setTimeout(90_000);
    const generations = new Set<string>();
    for (let attempt = 0; attempt < 10; attempt++) {
      const ready = await regenerateUntilReady(request, agentId);
      expect(ready.advertisement, `attempt ${attempt + 1}`).toEqual(fixture);
      expect(ready.error, `attempt ${attempt + 1}`).toBeNull();
      generations.add(ready.generation_id ?? "");
    }
    expect(generations.size).toBe(10);
  });
});

async function regenerateUntilReady(request: APIRequestContext, id: string) {
  const response = await request.post(endpoint, { data: { agent_id: id, action: "regenerate" } });
  expect(response.ok(), await response.text()).toBe(true);
  const requested = (await response.json() as Snapshot).advertisement;
  expect(requested?.status, `regeneration error: ${requested?.error ?? "none"}`).toMatch(/^(pending|ready)$/);
  const generationId = requested?.generation_id;
  expect(generationId).toEqual(expect.any(String));
  await expect.poll(async () => {
    const state = (await getSnapshot(request, id)).advertisement;
    if (!state || state.generation_id !== generationId) return `superseded:${state?.generation_id ?? "missing"}`;
    return state.status === "failed" ? `failed:${state.error}` : state.status;
  }, { timeout: 15_000 }).toBe("ready");
  return (await getSnapshot(request, id)).advertisement!;
}
function editorDialog(page: Page, title: string) {
  return page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

function trackAdvertisementRequests(page: Page) {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  page.on("request", (request) => {
    if (!request.url().includes(endpoint)) return;
    const raw = request.postData();
    requests.push({ method: request.method(), url: request.url(), body: raw ? JSON.parse(raw) : null });
  });
  return requests;
}

async function putPolicy(request: APIRequestContext, policy: Policy) {
  const response = await request.put(endpoint, { data: { policy } });
  expect(response.ok(), await response.text()).toBe(true);
  expect((await response.json() as Snapshot).policy).toEqual(policy);
}

async function getSnapshot(request: APIRequestContext, id: string) {
  const response = await request.get(`${endpoint}?agent_id=${encodeURIComponent(id)}`);
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as Snapshot;
}