import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupIsolatedToolTest } from "./test-helpers";

const t = setupIsolatedToolTest("jarela-test-jira-align-", {
  JIRA_ALIGN_URL: "https://acme.jiraalign.com",
  JIRA_ALIGN_TOKEN: "test-bearer-token",
});

const {
  jiraAlignListEntitiesTool,
  jiraAlignGetEntityTool,
  jiraAlignListCommentsTool,
  jiraAlignUpdateCommentTool,
  jiraAlignDeleteCommentTool,
  jiraAlignListDependenciesTool,
  jiraAlignCreateDependencyTool,
  jiraAlignDeleteDependencyTool,
  jiraAlignCreateEntityTool,
  jiraAlignUpdateEntityTool,
  jiraAlignDeleteEntityTool,
} = await import("./jira-align");

beforeEach(() => { t.reset(); });
afterEach(() => { t.cleanup(); });

describe("jira_align_list_entities", () => {
  it("routes program → /programs and applies $filter for name_filter", async () => {
    t.setResponses([{
      body: {
        items: [
          { id: 1, name: "Platform", description: "core infra", state: "active",
            programId: 1, parentId: null, isActive: true,
            startDate: "2026-01-01", endDate: "2026-12-31" },
        ],
      },
    }]);
    const out = JSON.parse(await jiraAlignListEntitiesTool.invoke({
      entity_type: "program", name_filter: "Platform",
    }));
    expect(t.calls[0].url).toMatch(/\/rest\/align\/api\/2\/programs\?/);
    expect(decodeURIComponent(t.calls[0].url).replace(/\+/g, " ")).toMatch(/\$filter=contains\(name, 'Platform'\)/);
    expect(out.entity_type).toBe("program");
    expect(out.items[0]).toMatchObject({
      id: 1, entity_type: "program", name: "Platform", state: "active",
      active: true, start_date: "2026-01-01", end_date: "2026-12-31",
    });
  });

  it("routes value_stream → /valueStreams (preserves camelCase)", async () => {
    t.setResponses([{ body: { items: [] } }]);
    await jiraAlignListEntitiesTool.invoke({ entity_type: "value_stream" });
    expect(t.calls[0].url).toMatch(/\/rest\/align\/api\/2\/valueStreams\?/);
  });

  it("routes sprint → /sprints", async () => {
    t.setResponses([{ body: { items: [] } }]);
    await jiraAlignListEntitiesTool.invoke({ entity_type: "sprint" });
    expect(t.calls[0].url).toMatch(/\/rest\/align\/api\/2\/sprints\?/);
  });

  it("clamps max_results to 100", async () => {
    t.setResponses([{ body: { items: [] } }]);
    await jiraAlignListEntitiesTool.invoke({ entity_type: "team", max_results: 9999 });
    expect(t.calls[0].url).toMatch(/limit=100/);
  });

  it("escapes single quotes in name_filter", async () => {
    t.setResponses([{ body: { items: [] } }]);
    await jiraAlignListEntitiesTool.invoke({ entity_type: "team", name_filter: "Bob's team" });
    expect(decodeURIComponent(t.calls[0].url).replace(/\+/g, " ")).toMatch(/contains\(name, 'Bob''s team'\)/);
  });

  it("combines name_filter and raw filter with AND", async () => {
    t.setResponses([{ body: { items: [] } }]);
    await jiraAlignListEntitiesTool.invoke({
      entity_type: "release", name_filter: "Q2", filter: "isActive eq true",
    });
    const decoded = decodeURIComponent(t.calls[0].url).replace(/\+/g, " ");
    expect(decoded).toMatch(/contains\(name, 'Q2'\) and \(isActive eq true\)/);
  });
});

describe("jira_align_get_entity", () => {
  it("routes portfolio → /portfolios/{id} and shapes the response", async () => {
    t.setResponses([{
      body: {
        id: 99, name: "Customer Experience",
        description: "CX value stream",
        state: "active", parentId: 10, programId: null,
        startDate: "2026-01-01", endDate: "2026-12-31",
        isActive: true,
      },
    }]);
    const out = JSON.parse(await jiraAlignGetEntityTool.invoke({
      entity_type: "portfolio", entity_id: "99",
    }));
    expect(t.calls[0].url).toMatch(/\/portfolios\/99$/);
    expect(out).toEqual({
      id: 99, entity_type: "portfolio", name: "Customer Experience",
      description: "CX value stream", state: "active", parent_id: 10,
      program_id: null, portfolio_id: null,
      start_date: "2026-01-01", end_date: "2026-12-31", active: true,
    });
  });

  it("falls back to title when name is missing", async () => {
    t.setResponses([{ body: { id: 5, title: "PI 26.1", state: "active" } }]);
    const out = JSON.parse(await jiraAlignGetEntityTool.invoke({
      entity_type: "sprint", entity_id: "5",
    }));
    expect(out.name).toBe("PI 26.1");
  });

  it("uses Bearer auth header (verify token round-trips)", async () => {
    t.setResponses([{ body: { id: 1, name: "x" } }]);
    await jiraAlignGetEntityTool.invoke({ entity_type: "team", entity_id: "1" });
    expect(((t.calls[0].init.headers ?? {}) as Record<string, string>)["Authorization"])
      .toBe("Bearer test-bearer-token");
  });
});

describe("jira_align_list_comments", () => {
  it("routes feature → /features/{id}/comments and shapes the response", async () => {
    t.setResponses([{
      body: {
        items: [
          { id: 11, body: "first comment", author: "alice@example.com",
            createDate: "2026-06-01T10:00:00Z", lastUpdated: "2026-06-01T10:05:00Z" },
        ],
      },
    }]);
    const out = JSON.parse(await jiraAlignListCommentsTool.invoke({
      type: "feature", item_id: "42",
    }));
    expect(t.calls[0].url).toMatch(/\/rest\/align\/api\/2\/features\/42\/comments\?/);
    expect(out.comments[0]).toMatchObject({
      id: 11, body: "first comment", author: "alice@example.com",
      created_at: "2026-06-01T10:00:00Z", updated_at: "2026-06-01T10:05:00Z",
    });
  });

  it("clamps max_results to 100", async () => {
    t.setResponses([{ body: { items: [] } }]);
    await jiraAlignListCommentsTool.invoke({ type: "story", item_id: "1", max_results: 500 });
    expect(t.calls[0].url).toMatch(/limit=100/);
  });
});

describe("jira_align_update_comment", () => {
  it("routes story → PATCH /stories/{id}/comments/{cid} with new body", async () => {
    t.setResponses([{ body: { ok: true } }]);
    const out = JSON.parse(await jiraAlignUpdateCommentTool.invoke({
      type: "story", item_id: "12", comment_id: "99", body: "edited",
    }));
    expect(t.calls[0].url).toMatch(/\/stories\/12\/comments\/99$/);
    expect(t.calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(t.calls[0].init.body as string)).toEqual({ body: "edited" });
    expect(out).toEqual({ ok: true, comment_id: "99", type: "story", item_id: "12" });
  });
});

describe("jira_align_delete_comment", () => {
  it("refuses without a confirm matching comment_id", async () => {
    const out = JSON.parse(await jiraAlignDeleteCommentTool.invoke({
      type: "epic", item_id: "5", comment_id: "77", confirm: "wrong",
    }));
    expect(out.error).toMatch(/Refusing to delete comment 77/);
    expect(t.calls.length).toBe(0);
  });

  it("DELETEs when confirm equals comment_id", async () => {
    t.setResponses([{ body: { ok: true } }]);
    const out = JSON.parse(await jiraAlignDeleteCommentTool.invoke({
      type: "epic", item_id: "5", comment_id: "77", confirm: "77",
    }));
    expect(t.calls[0].url).toMatch(/\/epics\/5\/comments\/77$/);
    expect(t.calls[0].init.method).toBe("DELETE");
    expect(out).toEqual({ ok: true, deleted_comment_id: "77", type: "epic", item_id: "5" });
  });
});

describe("jira_align_list_dependencies", () => {
  it("filters on successorId for direction=predecessor (this item is blocked)", async () => {
    t.setResponses([{ body: { items: [] } }]);
    await jiraAlignListDependenciesTool.invoke({ item_id: "100", direction: "predecessor" });
    const decoded = decodeURIComponent(t.calls[0].url).replace(/\+/g, " ");
    expect(decoded).toMatch(/\/rest\/align\/api\/2\/dependencies\?/);
    expect(decoded).toMatch(/\$filter=successorId eq 100/);
  });

  it("filters on predecessorId for direction=successor", async () => {
    t.setResponses([{ body: { items: [] } }]);
    await jiraAlignListDependenciesTool.invoke({ item_id: "200", direction: "successor" });
    const decoded = decodeURIComponent(t.calls[0].url).replace(/\+/g, " ");
    expect(decoded).toMatch(/\$filter=predecessorId eq 200/);
  });

  it("defaults to either-direction (OR clause)", async () => {
    t.setResponses([{ body: { items: [] } }]);
    await jiraAlignListDependenciesTool.invoke({ item_id: "300" });
    const decoded = decodeURIComponent(t.calls[0].url).replace(/\+/g, " ");
    expect(decoded).toMatch(/\(predecessorId eq 300 or successorId eq 300\)/);
  });

  it("normalises field casing (predecessorID vs predecessorId)", async () => {
    t.setResponses([{ body: { items: [{ id: 1, predecessorID: 10, successorID: 20, dependencyType: "FS" }] } }]);
    const out = JSON.parse(await jiraAlignListDependenciesTool.invoke({ item_id: "10" }));
    expect(out.dependencies[0]).toMatchObject({
      id: 1, predecessor_id: 10, successor_id: 20, dependency_type: "FS",
    });
  });
});

describe("jira_align_create_dependency", () => {
  it("POSTs /dependencies with predecessor/successor/type", async () => {
    t.setResponses([{ body: { id: 555 } }]);
    const out = JSON.parse(await jiraAlignCreateDependencyTool.invoke({
      predecessor_id: "1", successor_id: "2", dependency_type: "FS",
    }));
    expect(t.calls[0].url).toMatch(/\/rest\/align\/api\/2\/dependencies$/);
    expect(t.calls[0].init.method).toBe("POST");
    expect(JSON.parse(t.calls[0].init.body as string)).toEqual({
      predecessorId: "1", successorId: "2", dependencyType: "FS",
    });
    expect(out).toMatchObject({ ok: true, dependency_id: 555, predecessor_id: "1", successor_id: "2" });
  });

  it("omits dependency_type from body when not provided", async () => {
    t.setResponses([{ body: { id: 1 } }]);
    await jiraAlignCreateDependencyTool.invoke({ predecessor_id: "1", successor_id: "2" });
    expect(JSON.parse(t.calls[0].init.body as string)).not.toHaveProperty("dependencyType");
  });
});

describe("jira_align_delete_dependency", () => {
  it("refuses without confirm match", async () => {
    const out = JSON.parse(await jiraAlignDeleteDependencyTool.invoke({
      dependency_id: "42", confirm: "wrong",
    }));
    expect(out.error).toMatch(/Refusing to delete dependency 42/);
    expect(t.calls.length).toBe(0);
  });

  it("DELETEs /dependencies/{id} when confirm matches", async () => {
    t.setResponses([{ body: { ok: true } }]);
    const out = JSON.parse(await jiraAlignDeleteDependencyTool.invoke({
      dependency_id: "42", confirm: "42",
    }));
    expect(t.calls[0].url).toMatch(/\/dependencies\/42$/);
    expect(t.calls[0].init.method).toBe("DELETE");
    expect(out).toEqual({ ok: true, deleted_dependency_id: "42" });
  });
});

describe("jira_align_create_entity", () => {
  it("POSTs /<entity-collection> and shapes the response via summarizeEntity", async () => {
    t.setResponses([{
      body: { id: 42, name: "PI 26.3", state: "active",
        startDate: "2026-07-01", endDate: "2026-09-30", isActive: true },
    }]);
    const out = JSON.parse(await jiraAlignCreateEntityTool.invoke({
      entity_type: "sprint", name: "PI 26.3",
      start_date: "2026-07-01", end_date: "2026-09-30",
    }));
    expect(t.calls[0].url).toMatch(/\/rest\/align\/api\/2\/sprints$/);
    expect(t.calls[0].init.method).toBe("POST");
    const body = JSON.parse(t.calls[0].init.body as string);
    expect(body).toMatchObject({ name: "PI 26.3", startDate: "2026-07-01", endDate: "2026-09-30" });
    expect(out).toMatchObject({
      ok: true, id: 42, entity_type: "sprint", name: "PI 26.3",
      start_date: "2026-07-01", end_date: "2026-09-30", active: true,
    });
  });

  it("routes value_stream → /valueStreams (camelCase preserved)", async () => {
    t.setResponses([{ body: { id: 1, name: "x" } }]);
    await jiraAlignCreateEntityTool.invoke({ entity_type: "value_stream", name: "x" });
    expect(t.calls[0].url).toMatch(/\/valueStreams$/);
  });
});

describe("jira_align_update_entity", () => {
  it("rejects empty fields object", async () => {
    const out = JSON.parse(await jiraAlignUpdateEntityTool.invoke({
      entity_type: "team", entity_id: "1", fields: {},
    }));
    expect(out.error).toMatch(/at least one field/);
    expect(t.calls.length).toBe(0);
  });

  it("PATCHes /<collection>/{id} with the fields verbatim", async () => {
    t.setResponses([{ body: { ok: true } }]);
    const out = JSON.parse(await jiraAlignUpdateEntityTool.invoke({
      entity_type: "team", entity_id: "9", fields: { name: "Renamed", isActive: false },
    }));
    expect(t.calls[0].url).toMatch(/\/teams\/9$/);
    expect(t.calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(t.calls[0].init.body as string)).toEqual({ name: "Renamed", isActive: false });
    expect(out).toMatchObject({
      ok: true, id: "9", entity_type: "team", updated_fields: ["name", "isActive"],
    });
  });
});

describe("jira_align_delete_entity", () => {
  it("refuses without confirm match", async () => {
    const out = JSON.parse(await jiraAlignDeleteEntityTool.invoke({
      entity_type: "program", entity_id: "8", confirm: "nope",
    }));
    expect(out.error).toMatch(/Refusing to delete program 8/);
    expect(t.calls.length).toBe(0);
  });

  it("DELETEs /<collection>/{id} when confirm matches", async () => {
    t.setResponses([{ body: { ok: true } }]);
    const out = JSON.parse(await jiraAlignDeleteEntityTool.invoke({
      entity_type: "program", entity_id: "8", confirm: "8",
    }));
    expect(t.calls[0].url).toMatch(/\/programs\/8$/);
    expect(t.calls[0].init.method).toBe("DELETE");
    expect(out).toEqual({ ok: true, deleted_id: "8", entity_type: "program" });
  });
});
