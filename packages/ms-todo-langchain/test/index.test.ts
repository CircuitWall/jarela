import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setAuthResolver,
  resolveTodoAuthFromEnv,
  graphFetch,
  msTodoTools,
  msTodoReadTools,
  msTodoWriteTools,
  msTodoListListsTool,
  msTodoCreateListTool,
  msTodoListTasksTool,
  msTodoCreateTaskTool,
  msTodoUpdateTaskTool,
  msTodoCompleteTaskTool,
  msTodoDeleteTaskTool,
  msTodoAddChecklistItemTool,
} from "../src/index";

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

function installFetch() {
  const fake: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    calls.push({ url, init: init ?? {} });
    // Per the Fetch spec, status 204 / 205 / 304 responses must have a null
    // body. Node's undici enforces this strictly in the Response constructor.
    const body = nextResponse.status === 204 || nextResponse.status === 205 || nextResponse.status === 304
      ? null
      : JSON.stringify(nextResponse.body);
    return new Response(body, {
      status: nextResponse.status,
      headers: { "content-type": "application/json" },
    });
  };
  vi.stubGlobal("fetch", fake);
}

beforeEach(() => {
  setAuthResolver(() => ({ access_token: "test-token" }));
  calls = [];
  nextResponse = { status: 200, body: {} };
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MS_TODO_ACCESS_TOKEN;
  delete process.env.MS_TODO_CLIENT_ID;
  delete process.env.MS_TODO_CLIENT_SECRET;
  delete process.env.MS_TODO_REFRESH_TOKEN;
  delete process.env.MS_TODO_TENANT;
});

describe("resolveTodoAuthFromEnv", () => {
  it("prefers access token when present", () => {
    process.env.MS_TODO_ACCESS_TOKEN = "tok-abc";
    expect(resolveTodoAuthFromEnv()).toEqual({ access_token: "tok-abc" });
  });
  it("returns refresh-token bundle when client creds are set", () => {
    process.env.MS_TODO_CLIENT_ID = "id";
    process.env.MS_TODO_CLIENT_SECRET = "sec";
    process.env.MS_TODO_REFRESH_TOKEN = "rt";
    process.env.MS_TODO_TENANT = "tenant.onmicrosoft.com";
    expect(resolveTodoAuthFromEnv()).toEqual({
      client_id: "id",
      client_secret: "sec",
      refresh_token: "rt",
      tenant: "tenant.onmicrosoft.com",
    });
  });
  it("returns an error when nothing is configured", () => {
    const r = resolveTodoAuthFromEnv();
    expect("error" in r).toBe(true);
  });
});

describe("capability groups", () => {
  it("read + write partition the full tool set with no overlap", () => {
    const names = new Set<string>();
    for (const t of msTodoTools) {
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
    }
    expect(msTodoTools.length).toBe(msTodoReadTools.length + msTodoWriteTools.length);
  });
});

describe("ms_todo_list_lists", () => {
  it("GETs /me/todo/lists with the bearer token and slims the response", async () => {
    nextResponse = {
      status: 200,
      body: {
        value: [
          { id: "AQ==", displayName: "Tasks", isOwner: true, isShared: false, wellknownListName: "defaultList" },
          { id: "BQ==", displayName: "Groceries", isOwner: true, isShared: false },
        ],
      },
    };
    const out = await msTodoListListsTool.invoke({});
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/me/todo/lists?$top=100");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(JSON.parse(out)).toEqual({
      lists: [
        { id: "AQ==", name: "Tasks", is_owner: true, is_shared: false, well_known: "defaultList" },
        { id: "BQ==", name: "Groceries", is_owner: true, is_shared: false, well_known: null },
      ],
    });
  });

  it("propagates Graph error envelopes", async () => {
    nextResponse = { status: 401, body: { error: { code: "Unauthorized", message: "bad token" } } };
    const out = await msTodoListListsTool.invoke({});
    const parsed = JSON.parse(out) as { error?: string };
    expect(parsed.error).toContain("Graph 401");
  });
});

describe("ms_todo_create_list", () => {
  it("POSTs displayName and returns the slimmed envelope", async () => {
    nextResponse = { status: 201, body: { id: "NEW==", displayName: "Reading", isOwner: true } };
    const out = await msTodoCreateListTool.invoke({ name: "Reading" });
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/me/todo/lists");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ displayName: "Reading" });
    expect(JSON.parse(out)).toMatchObject({ id: "NEW==", name: "Reading", is_owner: true });
  });
});

describe("ms_todo_list_tasks", () => {
  it("builds the $filter clause from status + due_before + importance", async () => {
    nextResponse = { status: 200, body: { value: [] } };
    await msTodoListTasksTool.invoke({
      list_id: "L1",
      status: "notStarted",
      importance: "high",
      due_before: "2026-06-20T00:00:00Z",
      max_results: 10,
    });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v1.0/me/todo/lists/L1/tasks");
    expect(url.searchParams.get("$top")).toBe("10");
    expect(url.searchParams.get("$orderby")).toBe("createdDateTime desc");
    expect(url.searchParams.get("$filter")).toBe(
      "status eq 'notStarted' and importance eq 'high' and dueDateTime/dateTime lt '2026-06-20T00:00:00'",
    );
  });

  it("omits $filter when no filter args are provided", async () => {
    nextResponse = { status: 200, body: { value: [] } };
    await msTodoListTasksTool.invoke({ list_id: "L1" });
    const url = new URL(calls[0].url);
    expect(url.searchParams.has("$filter")).toBe(false);
  });
});

describe("ms_todo_create_task", () => {
  it("encodes due_iso into Graph's dateTime+timeZone envelope and strips trailing Z", async () => {
    nextResponse = {
      status: 201,
      body: { id: "T1", title: "Pay bill", status: "notStarted", importance: "high" },
    };
    const out = await msTodoCreateTaskTool.invoke({
      list_id: "L1",
      title: "Pay bill",
      importance: "high",
      due_iso: "2026-06-30T17:00:00Z",
      body: "Auto-pay failed",
    });
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks");
    expect(calls[0].init.method).toBe("POST");
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent.title).toBe("Pay bill");
    expect(sent.importance).toBe("high");
    expect(sent.body).toEqual({ content: "Auto-pay failed", contentType: "text" });
    expect(sent.dueDateTime).toEqual({ dateTime: "2026-06-30T17:00:00", timeZone: "UTC" });
    expect(JSON.parse(out)).toMatchObject({ id: "T1", title: "Pay bill", status: "notStarted" });
  });

  it("turns reminders on automatically when reminder_iso is provided", async () => {
    nextResponse = { status: 201, body: { id: "T2", title: "Ping" } };
    await msTodoCreateTaskTool.invoke({
      list_id: "L1",
      title: "Ping",
      reminder_iso: "2026-06-25T09:00:00",
      reminder_time_zone: "America/Los_Angeles",
    });
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent.reminderDateTime).toEqual({
      dateTime: "2026-06-25T09:00:00",
      timeZone: "America/Los_Angeles",
    });
    expect(sent.isReminderOn).toBe(true);
  });
});

describe("ms_todo_update_task", () => {
  it("rejects empty patches without making a network call", async () => {
    const out = await msTodoUpdateTaskTool.invoke({ list_id: "L1", task_id: "T1" });
    expect(calls).toHaveLength(0);
    expect(JSON.parse(out)).toEqual({ error: "Provide at least one field to update" });
  });

  it("sends null to clear a due date when clear_due is true", async () => {
    nextResponse = { status: 200, body: { id: "T1", title: "x" } };
    await msTodoUpdateTaskTool.invoke({ list_id: "L1", task_id: "T1", clear_due: true });
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent.dueDateTime).toBeNull();
  });

  it("clears both reminderDateTime AND isReminderOn when clear_reminder is true", async () => {
    nextResponse = { status: 200, body: { id: "T1", title: "x" } };
    await msTodoUpdateTaskTool.invoke({ list_id: "L1", task_id: "T1", clear_reminder: true });
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent.reminderDateTime).toBeNull();
    expect(sent.isReminderOn).toBe(false);
  });
});

describe("ms_todo_complete_task", () => {
  it("PATCHes status=completed", async () => {
    nextResponse = { status: 200, body: { id: "T1", title: "x", status: "completed" } };
    const out = await msTodoCompleteTaskTool.invoke({ list_id: "L1", task_id: "T1" });
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks/T1");
    expect(calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ status: "completed" });
    expect(JSON.parse(out)).toMatchObject({ status: "completed" });
  });
});

describe("ms_todo_delete_task", () => {
  it("DELETEs and returns ok:true", async () => {
    nextResponse = { status: 204, body: {} };
    const out = await msTodoDeleteTaskTool.invoke({ list_id: "L1", task_id: "T1" });
    expect(calls[0].init.method).toBe("DELETE");
    expect(JSON.parse(out)).toEqual({ ok: true, id: "T1" });
  });
});

describe("ms_todo_add_checklist_item", () => {
  it("POSTs the displayName under /checklistItems", async () => {
    nextResponse = { status: 201, body: { id: "C1", displayName: "Step 1", isChecked: false } };
    const out = await msTodoAddChecklistItemTool.invoke({
      list_id: "L1",
      task_id: "T1",
      name: "Step 1",
    });
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks/T1/checklistItems");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ displayName: "Step 1", isChecked: false });
    expect(JSON.parse(out)).toMatchObject({ id: "C1", name: "Step 1", is_checked: false });
  });
});

describe("graphFetch low-level escape hatch", () => {
  it("returns the auth error envelope when no resolver is configured", async () => {
    setAuthResolver(() => ({ error: "not configured" }));
    const r = await graphFetch("/me/todo/lists");
    expect(r).toEqual({ error: "not configured" });
  });

  it("returns { ok: true } on 204 No Content", async () => {
    nextResponse = { status: 204, body: {} };
    const r = await graphFetch("/me/todo/lists/X", { method: "DELETE" });
    expect(r).toEqual({ ok: true });
  });

  it("supports an async resolver", async () => {
    let called = 0;
    setAuthResolver(async () => {
      called++;
      return { access_token: "from-async" };
    });
    nextResponse = { status: 200, body: { value: [] } };
    await msTodoListListsTool.invoke({});
    expect(called).toBe(1);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer from-async");
  });
});

describe("refresh-token grant flow", () => {
  it("exchanges a refresh token for an access token before the Graph call", async () => {
    setAuthResolver(() => ({
      client_id: "cid",
      client_secret: "csec",
      refresh_token: "rt-1234567890123456789012345",
      tenant: "common",
    }));
    // First call is to the token endpoint, second to Graph.
    nextResponse = { status: 200, body: { access_token: "exchanged", expires_in: 3600 } };
    // Capture both: stub returns the same body for both, so set up a queue.
    const responses: Array<{ status: number; body: unknown }> = [
      { status: 200, body: { access_token: "exchanged", expires_in: 3600 } },
      { status: 200, body: { value: [{ id: "L1", displayName: "Tasks" }] } },
    ];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init: init ?? {} });
      const r = responses.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    });

    await msTodoListListsTool.invoke({});
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    const tokenBody = (calls[0].init.body as string) ?? "";
    expect(tokenBody).toContain("grant_type=refresh_token");
    expect(tokenBody).toContain("scope=offline_access+Tasks.ReadWrite");
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe("Bearer exchanged");
  });
});
