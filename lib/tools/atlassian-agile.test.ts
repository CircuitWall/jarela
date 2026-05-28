import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mirror atlassian.test.ts setup so the auth resolver picks up env creds and
// never touches the saved-integration store.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-atlassian-agile-"));
process.env.JARELA_DB_DIR = tmpRoot;
process.env.ATLASSIAN_URL = "https://test.atlassian.net";
process.env.ATLASSIAN_EMAIL = "tester@example.com";
process.env.ATLASSIAN_API_TOKEN = "test-token";
process.on("exit", () => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const {
  validateSprintTransition,
  jiraListBoardsTool,
  jiraGetBoardTool,
  jiraListSprintsTool,
  jiraGetSprintTool,
  jiraCreateSprintTool,
  jiraUpdateSprintTool,
  jiraDeleteSprintTool,
  jiraMoveIssuesToSprintTool,
  jiraMoveIssuesToBacklogTool,
  jiraRankIssuesTool,
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
    // Response disallows a body for 204/205/304 (per Fetch spec) — coerce to null.
    const noBodyStatus = status === 204 || status === 205 || status === 304;
    const bodyText = noBodyStatus
      ? null
      : typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(bodyText, {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  vi.stubGlobal("fetch", fake);
}

beforeEach(() => {
  calls = [];
  responses = [];
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Pure helper ─────────────────────────────────────────────────────────────

describe("validateSprintTransition", () => {
  it("rejects future as a target state", () => {
    const r = validateSprintTransition("future", "future" as never);
    expect("error" in r && r.error).toMatch(/cannot transition.*back to 'future'/);
  });

  it("allows future → active", () => {
    expect(validateSprintTransition("future", "active")).toEqual({ ok: true });
  });

  it("allows active → closed", () => {
    expect(validateSprintTransition("active", "closed")).toEqual({ ok: true });
  });

  it("rejects future → closed", () => {
    const r = validateSprintTransition("future", "closed");
    expect("error" in r && r.error).toMatch(/only 'active' sprints can be completed/);
  });

  it("rejects closed sprints", () => {
    const r = validateSprintTransition("closed", "active");
    expect("error" in r && r.error).toMatch(/already closed/);
  });

  it("treats unknown current state as fresh sprint when targeting active", () => {
    // Defensive: if Atlassian returns no state field, allow the transition rather
    // than blocking the agent on a missing field.
    expect(validateSprintTransition(undefined, "active")).toEqual({ ok: true });
  });
});

// ── Tool callbacks ──────────────────────────────────────────────────────────

describe("jira_list_boards", () => {
  it("hits /rest/agile/1.0/board with filters and shapes the response", async () => {
    responses = [{
      body: {
        values: [
          { id: 1, name: "Eng Scrum", type: "scrum", location: { projectKey: "ENG" } },
          { id: 2, name: "Eng Kanban", type: "kanban", location: { projectKey: "ENG" } },
        ],
        isLast: true,
      },
    }];
    const out = JSON.parse(await jiraListBoardsTool.invoke({
      project: "ENG", type: "scrum", max_results: 10,
    }));
    expect(calls[0].url).toMatch(/\/rest\/agile\/1\.0\/board\?/);
    expect(calls[0].url).toMatch(/projectKeyOrId=ENG/);
    expect(calls[0].url).toMatch(/type=scrum/);
    expect(calls[0].url).toMatch(/maxResults=10/);
    expect(out.boards).toHaveLength(2);
    expect(out.boards[0]).toEqual({ id: 1, name: "Eng Scrum", type: "scrum", project_key: "ENG" });
    expect(out.is_last).toBe(true);
  });

  it("clamps max_results to 100", async () => {
    responses = [{ body: { values: [], isLast: true } }];
    await jiraListBoardsTool.invoke({ max_results: 9999 });
    expect(calls[0].url).toMatch(/maxResults=100/);
  });
});

describe("jira_get_board", () => {
  it("merges metadata and configuration in parallel", async () => {
    responses = [
      { body: { id: 1, name: "Eng", type: "scrum", location: { projectKey: "ENG" } } },
      { body: {
        filter: { id: "1234" },
        subQuery: { query: "labels = important" },
        estimation: { field: { fieldId: "customfield_10016" } },
        ranking: { rankCustomFieldId: 10019 },
      } },
    ];
    const out = JSON.parse(await jiraGetBoardTool.invoke({ board_id: 1 }));
    expect(calls[0].url).toMatch(/\/board\/1$/);
    expect(calls[1].url).toMatch(/\/board\/1\/configuration$/);
    expect(out.configuration).toEqual({
      filter_id: "1234",
      sub_query: "labels = important",
      estimation_field: "customfield_10016",
      ranking_field: 10019,
    });
  });

  it("returns null configuration when the configuration call errors", async () => {
    responses = [
      { body: { id: 1, name: "Eng", type: "kanban", location: {} } },
      { status: 403, body: { message: "forbidden" } },
    ];
    const out = JSON.parse(await jiraGetBoardTool.invoke({ board_id: 1 }));
    expect(out.id).toBe(1);
    expect(out.configuration).toBeNull();
  });
});

describe("jira_list_sprints", () => {
  it("filters by state and shapes the response", async () => {
    responses = [{
      body: {
        values: [{
          id: 100, name: "Sprint 1", state: "active", goal: "ship MVP",
          startDate: "2026-01-01T00:00:00Z", endDate: "2026-01-14T00:00:00Z",
          completeDate: null, originBoardId: 1,
        }],
        isLast: false,
      },
    }];
    const out = JSON.parse(await jiraListSprintsTool.invoke({ board_id: 1, state: "active" }));
    expect(calls[0].url).toMatch(/\/board\/1\/sprint\?/);
    expect(calls[0].url).toMatch(/state=active/);
    expect(out.sprints[0]).toMatchObject({
      id: 100, name: "Sprint 1", state: "active", goal: "ship MVP",
      start_date: "2026-01-01T00:00:00Z", end_date: "2026-01-14T00:00:00Z",
      origin_board_id: 1,
    });
    expect(out.is_last).toBe(false);
  });
});

describe("jira_get_sprint", () => {
  it("fetches a sprint by id", async () => {
    responses = [{ body: { id: 100, name: "Sprint 1", state: "future", goal: null } }];
    const out = JSON.parse(await jiraGetSprintTool.invoke({ sprint_id: 100 }));
    expect(calls[0].url).toMatch(/\/sprint\/100$/);
    expect(out).toMatchObject({ id: 100, name: "Sprint 1", state: "future", goal: null });
  });
});

describe("jira_create_sprint", () => {
  it("posts originBoardId + name and returns the new id", async () => {
    responses = [{ status: 201, body: { id: 101, self: "https://test.atlassian.net/rest/agile/1.0/sprint/101" } }];
    const out = JSON.parse(await jiraCreateSprintTool.invoke({
      board_id: 1, name: "Sprint 2",
      goal: "ship feature X", start_date: "2026-02-01", end_date: "2026-02-14",
    }));
    expect(calls[0].init.method).toBe("POST");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({
      originBoardId: 1, name: "Sprint 2",
      goal: "ship feature X", startDate: "2026-02-01", endDate: "2026-02-14",
    });
    expect(out).toEqual({ ok: true, sprint_id: 101, board_id: 1 });
  });

  it("coerces string board_id to a number", async () => {
    responses = [{ body: { id: 102 } }];
    await jiraCreateSprintTool.invoke({ board_id: "7", name: "Sprint X" });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.originBoardId).toBe(7);
  });
});

describe("jira_update_sprint", () => {
  it("validates state transition before issuing the update", async () => {
    responses = [
      { body: { id: 100, state: "closed" } }, // current state lookup
    ];
    const out = JSON.parse(await jiraUpdateSprintTool.invoke({ sprint_id: 100, state: "active" }));
    expect(out.error).toMatch(/already closed/);
    expect(out.legal_next_states).toEqual([]);
    // Only the GET should have fired; no POST update on illegal transitions.
    expect(calls).toHaveLength(1);
  });

  it("starts a future sprint", async () => {
    responses = [
      { body: { id: 100, state: "future" } },
      { body: { id: 100, state: "active", name: "Sprint 1" } },
    ];
    const out = JSON.parse(await jiraUpdateSprintTool.invoke({ sprint_id: 100, state: "active" }));
    expect(calls[1].init.method).toBe("POST");
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ state: "active" });
    expect(out).toMatchObject({ ok: true, sprint_id: 100, state: "active" });
  });

  it("updates name + goal without a state transition", async () => {
    responses = [{ body: { id: 100, state: "active" } }];
    const out = JSON.parse(await jiraUpdateSprintTool.invoke({
      sprint_id: 100, name: "Renamed", goal: "new goal",
    }));
    expect(calls).toHaveLength(1); // no state lookup needed when state isn't changing
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ name: "Renamed", goal: "new goal" });
    expect(out.updated_fields).toEqual(["name", "goal"]);
  });

  it("rejects empty updates", async () => {
    const out = JSON.parse(await jiraUpdateSprintTool.invoke({ sprint_id: 100 }));
    expect(out.error).toMatch(/no fields to update/);
    expect(calls).toHaveLength(0);
  });
});

describe("jira_delete_sprint", () => {
  it("refuses without confirm matching sprint_id", async () => {
    const out = JSON.parse(await jiraDeleteSprintTool.invoke({ sprint_id: 100, confirm: 999 }));
    expect(out.error).toMatch(/Refusing to delete/);
    expect(calls).toHaveLength(0);
  });

  it("deletes when confirm matches (string-equal of stringified ids)", async () => {
    responses = [{ status: 204, body: "" }];
    const out = JSON.parse(await jiraDeleteSprintTool.invoke({ sprint_id: 100, confirm: "100" }));
    expect(calls[0].init.method).toBe("DELETE");
    expect(out).toEqual({ ok: true, deleted_sprint_id: 100 });
  });
});

describe("jira_move_issues_to_sprint", () => {
  it("posts issues array to /sprint/{id}/issue", async () => {
    responses = [{ status: 204, body: "" }];
    const out = JSON.parse(await jiraMoveIssuesToSprintTool.invoke({
      sprint_id: 100, issue_keys: ["PROJ-1", "PROJ-2"],
    }));
    expect(calls[0].url).toMatch(/\/sprint\/100\/issue$/);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ issues: ["PROJ-1", "PROJ-2"] });
    expect(out).toEqual({ ok: true, sprint_id: 100, moved: ["PROJ-1", "PROJ-2"] });
  });

  it("rejects empty issue_keys", async () => {
    const out = JSON.parse(await jiraMoveIssuesToSprintTool.invoke({ sprint_id: 100, issue_keys: [] }));
    expect(out.error).toMatch(/empty/);
    expect(calls).toHaveLength(0);
  });

  it("rejects more than 50 issues", async () => {
    const issue_keys = Array.from({ length: 51 }, (_, i) => `PROJ-${i + 1}`);
    const out = JSON.parse(await jiraMoveIssuesToSprintTool.invoke({ sprint_id: 100, issue_keys }));
    expect(out.error).toMatch(/up to 50/);
    expect(calls).toHaveLength(0);
  });
});

describe("jira_move_issues_to_backlog", () => {
  it("uses board-scoped path when board_id is given", async () => {
    responses = [{ status: 204, body: "" }];
    await jiraMoveIssuesToBacklogTool.invoke({ issue_keys: ["PROJ-1"], board_id: 1 });
    expect(calls[0].url).toMatch(/\/backlog\/1\/issue$/);
  });

  it("falls back to unscoped path without board_id", async () => {
    responses = [{ status: 204, body: "" }];
    await jiraMoveIssuesToBacklogTool.invoke({ issue_keys: ["PROJ-1"] });
    expect(calls[0].url).toMatch(/\/backlog\/issue$/);
  });
});

describe("jira_rank_issues", () => {
  it("requires exactly one of rank_before_issue / rank_after_issue", async () => {
    const both = JSON.parse(await jiraRankIssuesTool.invoke({
      issues: ["A-1"], rank_before_issue: "A-2", rank_after_issue: "A-3",
    }));
    expect(both.error).toMatch(/exactly one/);

    const neither = JSON.parse(await jiraRankIssuesTool.invoke({ issues: ["A-1"] }));
    expect(neither.error).toMatch(/exactly one/);
    expect(calls).toHaveLength(0);
  });

  it("PUTs to /rest/agile/1.0/issue/rank with the right body", async () => {
    responses = [{ status: 204, body: "" }];
    await jiraRankIssuesTool.invoke({
      issues: ["A-1", "A-2"], rank_after_issue: "A-3", rank_custom_field_id: 10019,
    });
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].url).toMatch(/\/issue\/rank$/);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      issues: ["A-1", "A-2"],
      rankAfterIssue: "A-3",
      rankCustomFieldId: 10019,
    });
  });
});
