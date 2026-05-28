import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-jira-align-"));
process.env.JARELA_DB_DIR = tmpRoot;
process.env.JIRA_ALIGN_URL = "https://acme.jiraalign.com";
process.env.JIRA_ALIGN_TOKEN = "test-bearer-token";
process.on("exit", () => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const {
  jiraAlignListEntitiesTool,
  jiraAlignGetEntityTool,
} = await import("./jira-align");

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

describe("jira_align_list_entities", () => {
  it("routes program → /programs and applies $filter for name_filter", async () => {
    responses = [{
      body: {
        items: [
          { id: 1, name: "Platform", description: "core infra", state: "active",
            programId: 1, parentId: null, isActive: true,
            startDate: "2026-01-01", endDate: "2026-12-31" },
        ],
      },
    }];
    const out = JSON.parse(await jiraAlignListEntitiesTool.invoke({
      entity_type: "program", name_filter: "Platform",
    }));
    expect(calls[0].url).toMatch(/\/rest\/align\/api\/2\/programs\?/);
    expect(decodeURIComponent(calls[0].url).replace(/\+/g, " ")).toMatch(/\$filter=contains\(name, 'Platform'\)/);
    expect(out.entity_type).toBe("program");
    expect(out.items[0]).toMatchObject({
      id: 1, entity_type: "program", name: "Platform", state: "active",
      active: true, start_date: "2026-01-01", end_date: "2026-12-31",
    });
  });

  it("routes value_stream → /valueStreams (preserves camelCase)", async () => {
    responses = [{ body: { items: [] } }];
    await jiraAlignListEntitiesTool.invoke({ entity_type: "value_stream" });
    expect(calls[0].url).toMatch(/\/rest\/align\/api\/2\/valueStreams\?/);
  });

  it("routes sprint → /sprints", async () => {
    responses = [{ body: { items: [] } }];
    await jiraAlignListEntitiesTool.invoke({ entity_type: "sprint" });
    expect(calls[0].url).toMatch(/\/rest\/align\/api\/2\/sprints\?/);
  });

  it("clamps max_results to 100", async () => {
    responses = [{ body: { items: [] } }];
    await jiraAlignListEntitiesTool.invoke({ entity_type: "team", max_results: 9999 });
    expect(calls[0].url).toMatch(/limit=100/);
  });

  it("escapes single quotes in name_filter", async () => {
    responses = [{ body: { items: [] } }];
    await jiraAlignListEntitiesTool.invoke({ entity_type: "team", name_filter: "Bob's team" });
    expect(decodeURIComponent(calls[0].url).replace(/\+/g, " ")).toMatch(/contains\(name, 'Bob''s team'\)/);
  });

  it("combines name_filter and raw filter with AND", async () => {
    responses = [{ body: { items: [] } }];
    await jiraAlignListEntitiesTool.invoke({
      entity_type: "release", name_filter: "Q2", filter: "isActive eq true",
    });
    const decoded = decodeURIComponent(calls[0].url).replace(/\+/g, " ");
    expect(decoded).toMatch(/contains\(name, 'Q2'\) and \(isActive eq true\)/);
  });
});

describe("jira_align_get_entity", () => {
  it("routes portfolio → /portfolios/{id} and shapes the response", async () => {
    responses = [{
      body: {
        id: 99, name: "Customer Experience",
        description: "CX value stream",
        state: "active", parentId: 10, programId: null,
        startDate: "2026-01-01", endDate: "2026-12-31",
        isActive: true,
      },
    }];
    const out = JSON.parse(await jiraAlignGetEntityTool.invoke({
      entity_type: "portfolio", entity_id: "99",
    }));
    expect(calls[0].url).toMatch(/\/portfolios\/99$/);
    expect(out).toEqual({
      id: 99, entity_type: "portfolio", name: "Customer Experience",
      description: "CX value stream", state: "active", parent_id: 10,
      program_id: null, portfolio_id: null,
      start_date: "2026-01-01", end_date: "2026-12-31", active: true,
    });
  });

  it("falls back to title when name is missing", async () => {
    responses = [{ body: { id: 5, title: "PI 26.1", state: "active" } }];
    const out = JSON.parse(await jiraAlignGetEntityTool.invoke({
      entity_type: "sprint", entity_id: "5",
    }));
    expect(out.name).toBe("PI 26.1");
  });

  it("uses Bearer auth header (verify token round-trips)", async () => {
    responses = [{ body: { id: 1, name: "x" } }];
    await jiraAlignGetEntityTool.invoke({ entity_type: "team", entity_id: "1" });
    expect(((calls[0].init.headers ?? {}) as Record<string, string>)["Authorization"])
      .toBe("Bearer test-bearer-token");
  });
});
