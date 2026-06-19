import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-integrations-test-route-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { saveIntegration, deleteIntegration } = await import("@/lib/stores/integrations");
const { listCredentials } = await import("@/lib/stores/credentials");
const { POST } = await import("@/app/api/v1/integrations/[name]/test/route");

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/integrations/github/test", {
    method: "POST",
    body: body === undefined ? "{}" : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.restoreAllMocks();
  deleteIntegration("github");
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("POST /api/v1/integrations/[name]/test", () => {
  it("404 for an unknown integration", async () => {
    const req = new NextRequest("http://localhost/api/v1/integrations/nope/test", { method: "POST", body: "{}" });
    const res = await POST(req, { params: Promise.resolve({ name: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("tests the default credential when no credentialId is supplied", async () => {
    saveIntegration("github", { token: "ghp_default" });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
      calls.push(auth);
      return jsonResponse({ login: "octocat" });
    }));

    const res = await POST(makeRequest(), { params: Promise.resolve({ name: "github" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(calls).toEqual(["Bearer ghp_default"]);
  });

  it("routes the probe to the supplied credentialId", async () => {
    // Two saved credentials for github. The second save creates a second row
    // (not default) — `saveIntegration` always upserts to the default slot,
    // so we use the store to insert a second non-default credential.
    saveIntegration("github", { token: "ghp_default" });
    const { createCredential } = await import("@/lib/stores/credentials");
    const second = createCredential({
      type: "integration",
      provider: "github",
      label: "alt",
      params: { token: "ghp_alt" },
      is_default: false,
    });

    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
      calls.push(auth);
      return jsonResponse({ login: "octocat" });
    }));

    const res = await POST(
      makeRequest({ credentialId: second.id }),
      { params: Promise.resolve({ name: "github" }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(calls).toEqual(["Bearer ghp_alt"]);

    // Sanity: confirm the alt row exists and is not default.
    const rows = listCredentials({ type: "integration", provider: "github" });
    expect(rows.find((r) => r.id === second.id)?.is_default).toBeFalsy();
  });

  it("404 when credentialId is unknown", async () => {
    saveIntegration("github", { token: "ghp_default" });
    const res = await POST(
      makeRequest({ credentialId: "no-such-credential" }),
      { params: Promise.resolve({ name: "github" }) },
    );
    expect(res.status).toBe(404);
  });

  it("400 when credentialId belongs to a different integration", async () => {
    saveIntegration("github", { token: "ghp_default" });
    saveIntegration("atlassian", { url: "https://x.atlassian.net", email: "a@b", api_token: "t" });
    const atlassianRow = listCredentials({ type: "integration", provider: "atlassian" })[0];
    expect(atlassianRow).toBeDefined();

    const res = await POST(
      makeRequest({ credentialId: atlassianRow!.id }),
      { params: Promise.resolve({ name: "github" }) },
    );
    expect(res.status).toBe(400);
  });

  it("400 when the integration has no saved credentials (unconfigured)", async () => {
    const res = await POST(makeRequest(), { params: Promise.resolve({ name: "github" }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false });
  });
});
