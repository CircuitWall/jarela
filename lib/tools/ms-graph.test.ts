/**
 * Tests for the Microsoft Graph "core" toolkit:
 *   - graphFetch resilience (401 re-auth, 429/503 backoff, 403 scope hints)
 *   - graphPaged @odata.nextLink follow
 *   - ms_graph_get / ms_search / ms_people_resolve request shape and
 *     output slimming
 *
 * We mock global fetch and route on URL: requests to the Microsoft token
 * endpoint return a synthetic access_token; requests to graph.microsoft.com
 * return whatever the test queues up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const TOKEN_URL_PREFIX = "https://login.microsoftonline.com";
const GRAPH_URL_PREFIX = "https://graph.microsoft.com/v1.0";

interface GraphResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

let graphResponses: GraphResponse[] = [];
let graphCalls: Array<{ url: string; init: RequestInit }> = [];
let tokenCalls = 0;

function queueGraph(...responses: GraphResponse[]): void {
  graphResponses.push(...responses);
}

beforeEach(async () => {
  graphResponses = [];
  graphCalls = [];
  tokenCalls = 0;

  process.env.OUTLOOK_CLIENT_ID = "test-client";
  process.env.OUTLOOK_CLIENT_SECRET = "test-secret";
  // Different per test to bypass the in-module access-token cache (cache
  // key is the first 20 chars of the refresh token).
  process.env.OUTLOOK_REFRESH_TOKEN = `rt-${Math.random().toString(36).slice(2, 18)}`;

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith(TOKEN_URL_PREFIX)) {
      tokenCalls += 1;
      return new Response(
        JSON.stringify({ access_token: `tok-${tokenCalls}`, expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    graphCalls.push({ url, init: init ?? {} });
    const next = graphResponses.shift();
    if (!next) {
      return new Response(JSON.stringify({ error: "no response queued" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    const body =
      next.status === 204 || next.status === 205 || next.status === 304
        ? null
        : typeof next.body === "string"
          ? next.body
          : JSON.stringify(next.body);
    return new Response(body, {
      status: next.status,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OUTLOOK_CLIENT_ID;
  delete process.env.OUTLOOK_CLIENT_SECRET;
  delete process.env.OUTLOOK_REFRESH_TOKEN;
});

describe("graphFetch resilience", () => {
  it("retries once on 401 after refreshing the access token", async () => {
    const { graphFetch, resolveMicrosoftAuth } = await import("@/lib/integrations/microsoft-oauth");
    const auth = resolveMicrosoftAuth() as { client_id: string; client_secret: string; refresh_token: string };
    queueGraph(
      { status: 401, body: { error: { code: "InvalidAuthenticationToken" } } },
      { status: 200, body: { value: ["ok"] } },
    );
    const r = await graphFetch(auth, "/me/messages");
    expect(r).toEqual({ value: ["ok"] });
    expect(graphCalls).toHaveLength(2);
    // Two token fetches: initial + post-401 refresh.
    expect(tokenCalls).toBeGreaterThanOrEqual(2);
  });

  it("retries on 429 honouring Retry-After (capped)", async () => {
    const { graphFetch, resolveMicrosoftAuth } = await import("@/lib/integrations/microsoft-oauth");
    const auth = resolveMicrosoftAuth() as { client_id: string; client_secret: string; refresh_token: string };
    queueGraph(
      { status: 429, body: { error: "rate" }, headers: { "Retry-After": "0" } },
      { status: 200, body: { value: [] } },
    );
    const r = await graphFetch(auth, "/me/messages");
    expect(r).toEqual({ value: [] });
    expect(graphCalls).toHaveLength(2);
  });

  it("emits a scope-aware hint on 403 for /me/people", async () => {
    const { graphFetch, resolveMicrosoftAuth } = await import("@/lib/integrations/microsoft-oauth");
    const auth = resolveMicrosoftAuth() as { client_id: string; client_secret: string; refresh_token: string };
    queueGraph({ status: 403, body: { error: { code: "AccessDenied" } } });
    const r = (await graphFetch(auth, "/me/people?$search=%22x%22")) as { error?: string };
    expect(r.error).toContain("Graph 403");
    expect(r.error).toContain("People.Read");
  });

  it("returns 204 No Content as { ok: true }", async () => {
    const { graphFetch, resolveMicrosoftAuth } = await import("@/lib/integrations/microsoft-oauth");
    const auth = resolveMicrosoftAuth() as { client_id: string; client_secret: string; refresh_token: string };
    queueGraph({ status: 204, body: null });
    const r = await graphFetch(auth, "/me/messages/123", { method: "DELETE" });
    expect(r).toEqual({ ok: true });
  });
});

describe("graphPaged @odata.nextLink follow", () => {
  it("merges value[] across pages until nextLink is absent", async () => {
    const { graphPaged, resolveMicrosoftAuth } = await import("@/lib/integrations/microsoft-oauth");
    const auth = resolveMicrosoftAuth() as { client_id: string; client_secret: string; refresh_token: string };
    queueGraph(
      {
        status: 200,
        body: {
          value: [{ id: "a" }, { id: "b" }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skip=2",
        },
      },
      { status: 200, body: { value: [{ id: "c" }] } },
    );
    const r = (await graphPaged(auth, "/me/messages")) as { value: Array<{ id: string }>; pages: number };
    expect(r.value.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(r.pages).toBe(2);
    expect(graphCalls).toHaveLength(2);
  });

  it("stops at maxPages", async () => {
    const { graphPaged, resolveMicrosoftAuth } = await import("@/lib/integrations/microsoft-oauth");
    const auth = resolveMicrosoftAuth() as { client_id: string; client_secret: string; refresh_token: string };
    queueGraph(
      { status: 200, body: { value: [1], "@odata.nextLink": "https://graph.microsoft.com/v1.0/x?p=2" } },
      { status: 200, body: { value: [2], "@odata.nextLink": "https://graph.microsoft.com/v1.0/x?p=3" } },
      { status: 200, body: { value: [3], "@odata.nextLink": "https://graph.microsoft.com/v1.0/x?p=4" } },
    );
    const r = (await graphPaged(auth, "/x", { maxPages: 2 })) as { value: number[]; pages: number };
    expect(r.value).toEqual([1, 2]);
    expect(r.pages).toBe(2);
  });
});

// ── Tool surface ───────────────────────────────────────────────────────────
// Importing ms-graph.ts auto-registers the tools. We hold a handle to the
// tool objects via the package registry so we can invoke them directly.

async function loadTools() {
  await import("./ms-graph");
  const { registeredTools } = await import("./registry");
  const all = registeredTools();
  const byName = new Map(all.map((t) => [t.name, t] as const));
  const get = byName.get("ms_graph_get");
  const search = byName.get("ms_search");
  const people = byName.get("ms_people_resolve");
  if (!get || !search || !people) throw new Error("ms-graph tools not registered");
  return { get, search, people };
}

describe("ms_graph_get", () => {
  it("performs a GET against the relative path with query params", async () => {
    const { get } = await loadTools();
    queueGraph({ status: 200, body: { value: [{ id: "drive-1" }] } });
    const out = await get.invoke({ path: "/me/drive/recent", query: { $top: "3" } });
    expect(graphCalls[0].url).toBe(`${GRAPH_URL_PREFIX}/me/drive/recent?%24top=3`);
    expect(JSON.parse(out as string)).toEqual({ value: [{ id: "drive-1" }] });
  });

  it("rejects absolute URLs", async () => {
    const { get } = await loadTools();
    const out = await get.invoke({ path: "/https://attacker.example/x" });
    expect(JSON.parse(out as string).error).toContain("relative Graph path");
  });

  it("follows pagination when paginate=true", async () => {
    const { get } = await loadTools();
    queueGraph(
      { status: 200, body: { value: [1], "@odata.nextLink": "https://graph.microsoft.com/v1.0/x?p=2" } },
      { status: 200, body: { value: [2] } },
    );
    const out = await get.invoke({ path: "/x", paginate: true });
    const parsed = JSON.parse(out as string);
    expect(parsed.value).toEqual([1, 2]);
    expect(parsed.pages).toBe(2);
  });
});

describe("ms_search", () => {
  it("POSTs /search/query with default entity types and slims hits", async () => {
    const { search } = await loadTools();
    queueGraph({
      status: 200,
      body: {
        value: [
          {
            hitsContainers: [
              {
                hits: [
                  {
                    hitId: "h1",
                    rank: 1,
                    summary: "matching email…",
                    resource: {
                      "@odata.type": "#microsoft.graph.message",
                      id: "msg-1",
                      subject: "Q4 results",
                      webLink: "https://outlook.office.com/?id=msg-1",
                      receivedDateTime: "2026-06-01T10:00:00Z",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const out = await search.invoke({ query: "q4" });
    const call = graphCalls[0];
    expect(call.url).toBe(`${GRAPH_URL_PREFIX}/search/query`);
    expect(call.init.method).toBe("POST");
    const sentBody = JSON.parse(call.init.body as string);
    expect(sentBody.requests[0].entityTypes).toEqual([
      "message",
      "event",
      "driveItem",
      "listItem",
    ]);
    expect(sentBody.requests[0].query.queryString).toBe("q4");
    const parsed = JSON.parse(out as string);
    expect(parsed.count).toBe(1);
    expect(parsed.hits[0]).toMatchObject({
      kind: "message",
      id: "msg-1",
      title: "Q4 results",
      summary: "matching email…",
      url: "https://outlook.office.com/?id=msg-1",
    });
  });

  it("respects custom entity_types and size", async () => {
    const { search } = await loadTools();
    queueGraph({ status: 200, body: { value: [] } });
    await search.invoke({ query: "alice", entity_types: ["person"], size: 3 });
    const sent = JSON.parse(graphCalls[0].init.body as string);
    expect(sent.requests[0].entityTypes).toEqual(["person"]);
    expect(sent.requests[0].size).toBe(3);
  });
});

describe("ms_people_resolve", () => {
  it("queries /me/people with $search and slims rows", async () => {
    const { people } = await loadTools();
    queueGraph({
      status: 200,
      body: {
        value: [
          {
            id: "p1",
            displayName: "Sarah Finance",
            jobTitle: "FP&A Lead",
            companyName: "Acme",
            department: "Finance",
            scoredEmailAddresses: [
              { address: "sarah@acme.example", relevanceScore: 12.3 },
            ],
            phones: [{ type: "business", number: "+1 555 0100" }],
          },
        ],
      },
    });
    const out = await people.invoke({ search: "sarah" });
    expect(graphCalls[0].url).toBe(`${GRAPH_URL_PREFIX}/me/people?%24search=%22sarah%22&%24top=5`);
    const parsed = JSON.parse(out as string);
    expect(parsed.count).toBe(1);
    expect(parsed.people[0]).toMatchObject({
      name: "Sarah Finance",
      job_title: "FP&A Lead",
      emails: [{ address: "sarah@acme.example", score: 12.3 }],
      phones: ["+1 555 0100"],
    });
  });
});
