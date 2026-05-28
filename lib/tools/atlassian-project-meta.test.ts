import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-project-meta-"));
process.env.JARELA_DB_DIR = tmpRoot;
process.env.ATLASSIAN_URL = "https://test.atlassian.net";
process.env.ATLASSIAN_EMAIL = "tester@example.com";
process.env.ATLASSIAN_API_TOKEN = "test-token";
process.on("exit", () => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const {
  jiraListProjectsTool,
  jiraGetProjectTool,
  jiraListVersionsTool,
  jiraCreateVersionTool,
  jiraUpdateVersionTool,
  jiraListComponentsTool,
  jiraCreateComponentTool,
  jiraListMetaTool,
} = await import("./atlassian");

type FetchCall = { url: string; init: RequestInit };
type QueuedResponse = { status?: number; body: unknown };

let calls: FetchCall[] = [];
let responses: QueuedResponse[] = [];

function installFetch() {
  const fake: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    calls.push({ url, init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    const status = next.status ?? 200;
    const noBody = status === 204 || status === 205 || status === 304;
    const bodyText = noBody ? null : typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(bodyText, { status, headers: { "content-type": "application/json" } });
  };
  vi.stubGlobal("fetch", fake);
}

beforeEach(() => { calls = []; responses = []; installFetch(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("jira_list_projects", () => {
  it("paginates and shapes the response", async () => {
    responses = [{
      body: {
        total: 3, isLast: true,
        values: [{
          id: "10000", key: "ENG", name: "Engineering",
          projectTypeKey: "software", style: "next-gen",
          lead: { displayName: "Alice" },
        }],
      },
    }];
    const out = JSON.parse(await jiraListProjectsTool.invoke({ query: "Eng", max_results: 25 }));
    expect(calls[0].url).toMatch(/\/project\/search\?/);
    expect(calls[0].url).toMatch(/query=Eng/);
    expect(calls[0].url).toMatch(/maxResults=25/);
    expect(out.total).toBe(3);
    expect(out.is_last).toBe(true);
    expect(out.projects[0]).toEqual({
      id: "10000", key: "ENG", name: "Engineering",
      type_key: "software", style: "next-gen", lead: "Alice",
    });
  });
});

describe("jira_get_project", () => {
  it("expands versions/components/issue_types when requested", async () => {
    responses = [{
      body: {
        id: "10000", key: "ENG", name: "Engineering",
        projectTypeKey: "software", style: "next-gen",
        lead: { displayName: "Alice" },
        versions: [{ id: "1", name: "v1.0", released: true, archived: false, releaseDate: "2026-01-01" }],
        components: [{ id: "100", name: "API", lead: { displayName: "Bob" } }],
        issueTypes: [{ id: "1", name: "Story", subtask: false, hierarchyLevel: 0 }],
      },
    }];
    const out = JSON.parse(await jiraGetProjectTool.invoke({
      project_key: "ENG",
      include_versions: true, include_components: true, include_issue_types: true,
    }));
    expect(calls[0].url).toMatch(/expand=versions,components,issueTypes/);
    expect(out.versions).toHaveLength(1);
    expect(out.versions[0]).toMatchObject({ name: "v1.0", released: true });
    expect(out.components[0]).toMatchObject({ name: "API", lead: "Bob" });
    expect(out.issue_types[0]).toMatchObject({ name: "Story", subtask: false });
    expect(out.url).toBe("https://test.atlassian.net/browse/ENG");
  });

  it("omits expansions when not requested", async () => {
    responses = [{
      body: { id: "10000", key: "ENG", name: "Engineering" },
    }];
    const out = JSON.parse(await jiraGetProjectTool.invoke({ project_key: "ENG" }));
    expect(calls[0].url).not.toMatch(/expand=/);
    expect(out.versions).toBeUndefined();
    expect(out.components).toBeUndefined();
  });
});

describe("jira_list_versions", () => {
  it("paginates with order_by", async () => {
    responses = [{
      body: {
        total: 2, isLast: true,
        values: [{
          id: "1", name: "v1.0", released: true, archived: false,
          releaseDate: "2026-01-01", description: "first",
        }],
      },
    }];
    const out = JSON.parse(await jiraListVersionsTool.invoke({
      project_key: "ENG", order_by: "-releaseDate",
    }));
    expect(calls[0].url).toMatch(/\/project\/ENG\/version\?/);
    expect(calls[0].url).toMatch(/orderBy=-releaseDate/);
    expect(out.versions[0]).toMatchObject({ id: "1", name: "v1.0", released: true });
  });
});

describe("jira_create_version", () => {
  it("resolves project_key to id then POSTs", async () => {
    responses = [
      { body: { id: "10000", key: "ENG" } },
      { body: { id: "12345", name: "v2.0" } },
    ];
    const out = JSON.parse(await jiraCreateVersionTool.invoke({
      project_key: "ENG", name: "v2.0", release_date: "2026-06-15",
    }));
    expect(calls[0].url).toMatch(/\/project\/ENG$/);
    expect(calls[1].url).toMatch(/\/version$/);
    const body = JSON.parse(calls[1].init.body as string);
    expect(body).toEqual({ projectId: 10000, name: "v2.0", releaseDate: "2026-06-15" });
    expect(out).toEqual({ ok: true, version_id: "12345", name: "v2.0" });
  });

  it("surfaces missing project id", async () => {
    responses = [{ body: { key: "ENG" } }]; // no id field
    const out = JSON.parse(await jiraCreateVersionTool.invoke({ project_key: "ENG", name: "v2.0" }));
    expect(out.error).toMatch(/could not resolve project_key/);
    expect(calls).toHaveLength(1);
  });
});

describe("jira_update_version", () => {
  it("PUTs only the specified fields and returns released/archived", async () => {
    responses = [{ body: { id: "12345", released: true, archived: false } }];
    const out = JSON.parse(await jiraUpdateVersionTool.invoke({
      version_id: "12345", released: true, release_date: "2026-06-30",
    }));
    expect(calls[0].init.method).toBe("PUT");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({ released: true, releaseDate: "2026-06-30" });
    expect(out).toMatchObject({ ok: true, released: true, archived: false });
    expect(new Set(out.updated_fields)).toEqual(new Set(["released", "releaseDate"]));
  });

  it("rejects empty updates", async () => {
    const out = JSON.parse(await jiraUpdateVersionTool.invoke({ version_id: "12345" }));
    expect(out.error).toMatch(/no fields to update/);
    expect(calls).toHaveLength(0);
  });
});

describe("jira_list_components", () => {
  it("returns the array unwrapped", async () => {
    responses = [{
      body: [
        { id: "100", name: "API", description: "REST", lead: { displayName: "Bob" }, assigneeType: "PROJECT_LEAD" },
      ],
    }];
    const out = JSON.parse(await jiraListComponentsTool.invoke({ project_key: "ENG" }));
    expect(out.components[0]).toEqual({
      id: "100", name: "API", description: "REST", lead: "Bob", assignee_type: "PROJECT_LEAD",
    });
  });
});

describe("jira_create_component", () => {
  it("posts project + name + assignee_type", async () => {
    responses = [{ body: { id: "200", name: "Frontend" } }];
    const out = JSON.parse(await jiraCreateComponentTool.invoke({
      project_key: "ENG", name: "Frontend",
      lead_account_id: "abc-123", assignee_type: "COMPONENT_LEAD",
    }));
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({
      project: "ENG", name: "Frontend",
      leadAccountId: "abc-123", assigneeType: "COMPONENT_LEAD",
    });
    expect(out).toEqual({ ok: true, component_id: "200", name: "Frontend" });
  });
});

describe("jira_list_meta", () => {
  it("lists available kinds when no kind passed", async () => {
    const out = JSON.parse(await jiraListMetaTool.invoke({}));
    expect(out.available_kinds).toEqual(["issue_type", "priority", "status", "resolution"]);
    expect(calls).toHaveLength(0);
  });

  it("dispatches to /issuetype for issue_type", async () => {
    responses = [{ body: [{ id: "1", name: "Story", subtask: false, hierarchyLevel: 0 }] }];
    const out = JSON.parse(await jiraListMetaTool.invoke({ kind: "issue_type" }));
    expect(calls[0].url).toMatch(/\/rest\/api\/3\/issuetype$/);
    expect(out.kind).toBe("issue_type");
    expect(out.values[0]).toMatchObject({ id: "1", name: "Story", subtask: false, hierarchy_level: 0 });
  });

  it("dispatches to /priority for priority", async () => {
    responses = [{ body: [{ id: "1", name: "Highest", description: "" }] }];
    await jiraListMetaTool.invoke({ kind: "priority" });
    expect(calls[0].url).toMatch(/\/priority$/);
  });

  it("dispatches to /status with status_category surfaced", async () => {
    responses = [{
      body: [{
        id: "1", name: "To Do",
        statusCategory: { name: "To Do" },
      }],
    }];
    const out = JSON.parse(await jiraListMetaTool.invoke({ kind: "status" }));
    expect(calls[0].url).toMatch(/\/status$/);
    expect(out.values[0]).toMatchObject({ id: "1", name: "To Do", status_category: "To Do" });
  });

  it("dispatches to /resolution for resolution", async () => {
    responses = [{ body: [{ id: "1", name: "Done", description: "completed" }] }];
    await jiraListMetaTool.invoke({ kind: "resolution" });
    expect(calls[0].url).toMatch(/\/resolution$/);
  });
});
