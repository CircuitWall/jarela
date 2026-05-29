import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupIsolatedToolTest } from "./test-helpers";

const t = setupIsolatedToolTest("jarela-test-jira-align-", {
  JIRA_ALIGN_URL: "https://acme.jiraalign.com",
  JIRA_ALIGN_TOKEN: "test-bearer-token",
});

const {
  jiraAlignListEntitiesTool,
  jiraAlignGetEntityTool,
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
