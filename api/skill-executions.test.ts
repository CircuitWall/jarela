import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ locked: false, local: true, request: vi.fn(), inspect: vi.fn(), cancel: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ isLoopbackRequest: () => state.local }));
vi.mock("@/lib/crypto/master-key", () => ({ isMasterKeyLocked: () => state.locked }));
vi.mock("@/lib/security/screen-lock", () => ({ isScreenLocked: () => false }));
vi.mock("@/lib/skills/execution-service", () => ({ skillExecutionService: () => state }));
import { POST } from "@/app/api/v1/skill-executions/route";
import { GET, DELETE } from "@/app/api/v1/skill-executions/[id]/route";

const context = { params: Promise.resolve({ id: "synthetic" }) };
function req(body?: unknown) {
  return new NextRequest("http://localhost/api/v1/skill-executions", {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}
beforeEach(() => {
  vi.clearAllMocks(); state.locked = false; state.local = true;
  state.request.mockResolvedValue({ request_id: "synthetic", status: "pending" });
  state.inspect.mockReturnValue({ request_id: "synthetic", status: "pending" });
});
describe("local skill execution boundary", () => {
  it("queues a validated explicit request without claiming execution", async () => {
    const response = await POST(req({ agent_id: "agent", skill_id: "skill", input_json: "{}", workspace: "workspace" }));
    expect(await response.json()).toMatchObject({ status: "pending" });
    expect(state.request).toHaveBeenCalledWith({ agentId: "agent", skillId: "skill", inputJson: "{}", workspace: "workspace" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await GET(req(), context)).status).toBe(200);
    expect((await DELETE(req(), context)).status).toBe(200);
  });
  it("refuses locked and nonlocal callers on every operation", async () => {
    for (const reason of ["locked", "remote"]) {
      state.locked = reason === "locked"; state.local = reason !== "remote";
      expect((await POST(req({}))).status).toBe(reason === "locked" ? 423 : 403);
      expect((await GET(req(), context)).status).toBe(reason === "locked" ? 423 : 403);
      expect((await DELETE(req(), context)).status).toBe(reason === "locked" ? 423 : 403);
    }
    expect(state.request).not.toHaveBeenCalled();
    expect(state.cancel).not.toHaveBeenCalled();
  });
  it("rejects malformed schemas and reports missing live requests explicitly", async () => {
    expect((await POST(req({ agent_id: "agent", input_json: {}, unexpected: true }))).status).toBe(400);
    state.inspect.mockImplementation(() => { throw new Error("expired"); });
    expect((await GET(req(), context)).status).toBe(404);
    expect(state.request).not.toHaveBeenCalled();
  });
});
