import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { GET as getItem, POST as mutate } from "./[id]/route";

const mocks = vi.hoisted(() => ({
  local: true, keyLocked: false, screenLocked: false,
  service: { create: vi.fn(), inspect: vi.fn(), list: vi.fn(), advance: vi.fn(), answer: vi.fn(), cancel: vi.fn(), reconcile: vi.fn() },
}));
vi.mock("@/lib/auth/access", () => ({ isLoopbackRequest: () => mocks.local }));
vi.mock("@/lib/crypto/master-key", () => ({ isMasterKeyLocked: () => mocks.keyLocked }));
vi.mock("@/lib/security/screen-lock", () => ({ isScreenLocked: () => mocks.screenLocked }));
vi.mock("@/lib/workflows/service", () => ({ getWorkflowService: () => mocks.service }));
const id = "40f726d3-f566-4984-8a1b-32359db47935";
const params = { params: Promise.resolve({ id }) };
const request = (path = "?agentId=one", body?: unknown, headers?: Record<string, string>) => new NextRequest(
  `http://localhost/api/v1/workflows${path}`, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: { "content-type": "application/json", ...headers },
  });
beforeEach(() => {
  vi.clearAllMocks(); mocks.local = true; mocks.keyLocked = false; mocks.screenLocked = false;
  for (const fn of Object.values(mocks.service)) fn.mockReturnValue({ id, agentId: "one", phase: "ready" });
});

describe("workflow local unlocked API", () => {
  it("denies remote and Tailscale-forwarded requests before reading workflow state", async () => {
    mocks.local = false;
    expect((await GET(request())).status).toBe(403);
    expect((await POST(request("", {}))).status).toBe(403);
    expect((await getItem(request(), params)).status).toBe(403);
    expect((await mutate(request("", {}), params)).status).toBe(403);
    mocks.local = true;
    expect((await GET(request("", undefined, { "tailscale-user-login": "local-looking" }))).status).toBe(403);
    expect(mocks.service.list).not.toHaveBeenCalled();
  });

  it("denies both master-key and screen locks", async () => {
    for (const state of ["keyLocked", "screenLocked"] as const) {
      mocks[state] = true;
      expect((await GET(request())).status).toBe(423);
      expect((await POST(request("", {}))).status).toBe(423);
      expect((await getItem(request(), params)).status).toBe(423);
      expect((await mutate(request("", {}), params)).status).toBe(423);
      mocks[state] = false;
    }
    expect(mocks.service.create).not.toHaveBeenCalled();
  });

  it("validates agent scope, IDs, pagination, strict definitions and invocation at the boundary", async () => {
    expect((await GET(request(""))).status).toBe(400);
    expect((await GET(request("?agentId=one&limit=101"))).status).toBe(400);
    expect((await getItem(request(), { params: Promise.resolve({ id: "invalid" }) })).status).toBe(400);
    const body = { agentId: "one", workspace: process.cwd(), definitionText: '{"schemaVersion":1,"id":"bad","steps":[]}' };
    expect((await POST(request("", body))).status).toBe(400);
    const schema = { type: "object", properties: {}, additionalProperties: false };
    const valid = { ...body, definitionText: JSON.stringify({
      schemaVersion: 1, id: "valid", steps: [{
        id: "first", kind: "tool", action: "read", effect: "read", input: { from: "literal", value: {} },
        inputSchema: schema, outputSchema: schema,
      }],
    }) };
    expect((await POST(request("", { ...valid, invocationJson: '{"unknown":true}' }))).status).toBe(400);
    expect(mocks.service.create).not.toHaveBeenCalled();
    const created = await POST(request("", valid));
    expect(created.status).toBe(200);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(mocks.service.create).toHaveBeenCalledWith("one", valid.definitionText, "{}", process.cwd());
    await GET(request("?agentId=one&limit=2"));
    expect(mocks.service.list).toHaveBeenCalledWith("one", 2, undefined);
    await getItem(request(), params);
    expect(mocks.service.inspect).toHaveBeenCalledWith("one", id);
  });

  it("binds typed answers and versions and never accepts caller-asserted reconciliation evidence", async () => {
    const invalid = [
      { action: "answer", agentId: "one", version: 1 },
      { action: "cancel", agentId: "one", version: 0 },
      { action: "advance", version: 1 },
      { action: "reconcile", agentId: "one", version: 1, outputJson: "{}", evidence: "I say it ran" },
    ];
    for (const body of invalid) expect((await mutate(request("", body), params)).status).toBe(400);
    const answer = { action: "answer", agentId: "one", version: 3, revision: "a".repeat(64), stepId: "question", answerJson: '{"decision":"keep"}' };
    expect((await mutate(request("", answer), params)).status).toBe(200);
    expect(mocks.service.answer).toHaveBeenCalledWith("one", id, answer);
    for (const action of ["advance", "cancel", "reconcile"] as const) {
      expect((await mutate(request("", { action, agentId: "one", version: 4 }), params)).status).toBe(200);
      expect(mocks.service[action].mock.calls[0].slice(0, 3)).toEqual(["one", id, 4]);
    }
  });

  it("returns conflicts and scoped not-found errors without leaking internal failures", async () => {
    mocks.service.inspect.mockImplementation(() => { throw new Error("Workflow run not found"); });
    expect((await getItem(request(), params)).status).toBe(404);
    mocks.service.cancel.mockRejectedValue(new Error("Secret internal host trace"));
    const response = await mutate(request("", { action: "cancel", agentId: "one", version: 1 }), params);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("Secret internal host trace");
  });
});
