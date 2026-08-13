import { test, expect, type APIRequestContext } from "@playwright/test";
import { dismissOverlayBanners, seedMockAgent, waitForAppReady } from "./helpers";

// Coverage for the multi-instance, named-and-typed credentials feature:
//   - first row of a (type, provider) pair auto-labels to "Default"
//   - subsequent rows accept a user-supplied label
//   - is_default routing: promote, demote, delete-and-promote-survivor
//   - per-agent tool_credentials map round-trips through the agent API
//   - the panel UI renders only configured credentials, grouped per
//     provider, with "default" badge + "Add another" button
//
// All tests run serially because they share the dev server's
// JARELA_DB_DIR. Each test cleans up its own credentials in afterEach.
test.describe.configure({ mode: "serial" });

// A synthetic "model" provider that won't collide with anything a
// developer has actually configured. Using the model type keeps the
// integration registry out of the picture for the API-only tests, so
// we don't depend on whether the env happens to have github/gmail
// definitions registered.
const TEST_PROVIDER = "e2e-multi";

async function listTestCredentials(request: APIRequestContext) {
  const r = await request.get(`/api/v1/credentials?type=model&provider=${TEST_PROVIDER}`);
  if (!r.ok()) return [];
  return (await r.json()) as Array<{
    id: string;
    type: string;
    provider: string;
    label: string | null;
    is_default: boolean;
    auth_method: string;
  }>;
}

async function wipeTestCredentials(request: APIRequestContext) {
  const rows = await listTestCredentials(request);
  for (const row of rows) {
    await request.delete(`/api/v1/credentials/${encodeURIComponent(row.id)}`);
  }
}

test.afterEach(async ({ request }) => {
  await wipeTestCredentials(request);
});

test.describe("multi-instance credentials API", () => {
  test("first credential of a (type, provider) pair auto-labels to 'Default' and is_default=true", async ({ request }) => {
    const r = await request.post("/api/v1/credentials", {
      data: {
        type: "model",
        provider: TEST_PROVIDER,
        auth_method: "api_key",
        params: { api_key: "k1" },
      },
    });
    expect(r.ok()).toBeTruthy();
    const body = (await r.json()) as { label: string | null; is_default: boolean; id: string };
    expect(body.label).toBe("Default");
    expect(body.is_default).toBe(true);
    expect(body.id).toBe(`model-${TEST_PROVIDER}`);
  });

  test("second credential keeps the caller-supplied label and is_default=false", async ({ request }) => {
    await request.post("/api/v1/credentials", {
      data: { type: "model", provider: TEST_PROVIDER, params: { api_key: "k1" } },
    });
    const r = await request.post("/api/v1/credentials", {
      data: {
        type: "model",
        provider: TEST_PROVIDER,
        label: "Personal",
        params: { api_key: "k2" },
      },
    });
    expect(r.ok()).toBeTruthy();
    const body = (await r.json()) as { label: string | null; is_default: boolean; id: string };
    expect(body.label).toBe("Personal");
    expect(body.is_default).toBe(false);
    expect(body.id).not.toBe(`model-${TEST_PROVIDER}`); // auto-bumped to ...-2 / ...
  });

  test("PUT is_default=true promotes the target and demotes the previous default", async ({ request }) => {
    const first = await (await request.post("/api/v1/credentials", {
      data: { type: "model", provider: TEST_PROVIDER, params: { api_key: "k1" } },
    })).json() as { id: string };
    const second = await (await request.post("/api/v1/credentials", {
      data: { type: "model", provider: TEST_PROVIDER, label: "Other", params: { api_key: "k2" } },
    })).json() as { id: string };

    const promote = await request.put(`/api/v1/credentials/${encodeURIComponent(second.id)}`, {
      data: { is_default: true },
    });
    expect(promote.ok()).toBeTruthy();

    const all = await listTestCredentials(request);
    const promoted = all.find((c) => c.id === second.id);
    const demoted = all.find((c) => c.id === first.id);
    expect(promoted?.is_default).toBe(true);
    expect(demoted?.is_default).toBe(false);
  });

  test("deleting the default credential promotes the surviving sibling", async ({ request }) => {
    const first = await (await request.post("/api/v1/credentials", {
      data: { type: "model", provider: TEST_PROVIDER, params: { api_key: "k1" } },
    })).json() as { id: string; is_default: boolean };
    const second = await (await request.post("/api/v1/credentials", {
      data: { type: "model", provider: TEST_PROVIDER, label: "Other", params: { api_key: "k2" } },
    })).json() as { id: string; is_default: boolean };
    expect(first.is_default).toBe(true);
    expect(second.is_default).toBe(false);

    const del = await request.delete(`/api/v1/credentials/${encodeURIComponent(first.id)}`);
    expect(del.ok()).toBeTruthy();

    const surviving = await listTestCredentials(request);
    expect(surviving.length).toBe(1);
    expect(surviving[0]!.id).toBe(second.id);
    expect(surviving[0]!.is_default).toBe(true);
  });

  test("POST defaults label/is_default behaviour also applies via API field omission", async ({ request }) => {
    // Caller doesn't supply label or is_default at all → first row still
    // gets "Default" + is_default=true (server-side default).
    const r = await request.post("/api/v1/credentials", {
      data: { type: "model", provider: TEST_PROVIDER, params: { api_key: "k1" } },
    });
    const body = (await r.json()) as { label: string | null; is_default: boolean };
    expect(body.label).toBe("Default");
    expect(body.is_default).toBe(true);
  });
});

test.describe("per-agent tool_credentials API", () => {
  // Agents created during these tests are cleaned up by name.
  const agentName = "E2E Tool Credentials";

  test.afterEach(async ({ request }) => {
    const list = await request.get("/api/v1/agents");
    if (!list.ok()) return;
    const agents = (await list.json()) as Array<{ id: string; name: string }>;
    for (const a of agents) {
      if (a.name === agentName) {
        await request.delete(`/api/v1/agents/${encodeURIComponent(a.id)}`);
      }
    }
  });

  test("POST agent with tool_credentials map round-trips through GET", async ({ request }) => {
    const cred = await (await request.post("/api/v1/credentials", {
      data: { type: "model", provider: TEST_PROVIDER, label: "Pinned", params: { api_key: "k1" } },
    })).json() as { id: string };

    const create = await request.post("/api/v1/agents", {
      data: {
        name: agentName,
        identity: "tool-creds test",
        instructions: "noop",
        tools: ["github_create_issue"],
        tool_credentials: { github_create_issue: cred.id },
      },
    });
    expect(create.ok()).toBeTruthy();
    const created = (await create.json()) as { id: string; tool_credentials: Record<string, string> };
    expect(created.tool_credentials).toEqual({ github_create_issue: cred.id });

    const get = await request.get(`/api/v1/agents/${encodeURIComponent(created.id)}`);
    expect(get.ok()).toBeTruthy();
    const fetched = (await get.json()) as { tool_credentials: Record<string, string> };
    expect(fetched.tool_credentials).toEqual({ github_create_issue: cred.id });
  });

  test("PATCHing tool_credentials to {} clears the overrides", async ({ request }) => {
    const cred = await (await request.post("/api/v1/credentials", {
      data: { type: "model", provider: TEST_PROVIDER, params: { api_key: "k1" } },
    })).json() as { id: string };

    const created = await (await request.post("/api/v1/agents", {
      data: {
        name: agentName,
        identity: "tool-creds clear test",
        instructions: "noop",
        tools: ["gmail_send"],
        tool_credentials: { gmail_send: cred.id },
      },
    })).json() as { id: string };

    const updated = await request.put(`/api/v1/agents/${encodeURIComponent(created.id)}`, {
      data: {
        name: agentName,
        identity: "tool-creds clear test",
        instructions: "noop",
        tools: ["gmail_send"],
        tool_credentials: {},
      },
    });
    expect(updated.ok()).toBeTruthy();
    const after = (await updated.json()) as { tool_credentials: Record<string, string> };
    expect(after.tool_credentials).toEqual({});
  });
});

test.describe("credentials panel UI", () => {
  test.beforeEach(async ({ page, request }) => {
    await seedMockAgent(request);
    await dismissOverlayBanners(page);
  });

  test("panel renders configured credentials grouped by provider with 'default' badge", async ({ page, request }) => {
    // Seed two credentials for the synthetic provider. The panel groups
    // by provider regardless of whether the integration registry has a
    // matching definition (unknown providers land in the 'Other' bucket).
    await request.post("/api/v1/credentials", {
      data: { type: "model", provider: TEST_PROVIDER, params: { api_key: "k1" } },
    });
    await request.post("/api/v1/credentials", {
      data: { type: "model", provider: TEST_PROVIDER, label: "Personal", params: { api_key: "k2" } },
    });

    await page.goto("/?tab=credentials");
    await waitForAppReady(page);
    await expect(page.getByRole("heading", { name: "Credentials" })).toBeVisible();

    // Both rows render — the auto-Default one and the Personal one.
    const defaultRow = page.locator(`li[data-deep-link-id="model-${TEST_PROVIDER}"]`);
    const personalRow = page.locator(`li[data-deep-link-id^="model-${TEST_PROVIDER}-"]`);
    await expect(defaultRow).toBeVisible();
    await expect(personalRow).toBeVisible();

    // The default row carries the visible "default" badge; the other doesn't.
    await expect(defaultRow.getByText("default", { exact: true })).toBeVisible();
    await expect(personalRow.getByText("default", { exact: true })).toHaveCount(0);

    // The provider group exposes its "Add another" affordance.
    const group = page.locator(`[data-deep-link-id="${TEST_PROVIDER}"]`);
    await expect(group.getByTitle(/Add another credential/)).toBeVisible();

    // Rows are clickable to edit; Delete button is present per row.
    await expect(defaultRow.getByTitle("Delete")).toBeVisible();
  });

  test("panel shows featured Claude card when no credentials exist", async ({ page, request }) => {
    await wipeTestCredentials(request); // belt-and-suspenders — afterEach should already have cleared
    // Also wipe any pre-existing model credentials the dev env created;
    // the empty-state copy renders only when the FULL list is empty.
    const all = await request.get("/api/v1/credentials");
    if (all.ok()) {
      for (const c of (await all.json()) as Array<{ id: string }>) {
        await request.delete(`/api/v1/credentials/${encodeURIComponent(c.id)}`);
      }
    }
    try {
      await page.goto("/?tab=credentials");
      await waitForAppReady(page);
      await expect(page.getByRole("heading", { name: "Credentials" })).toBeVisible();
      await expect(page.getByText("Featured", { exact: true })).toBeVisible();
      await expect(page.getByText("Claude Code", { exact: true })).toBeVisible();
    } finally {
      // Re-seed the mock model so other tests in the file still pass.
      // seedMockAgent's POST is idempotent on the model name.
      await seedMockAgent(request);
    }
  });
});
