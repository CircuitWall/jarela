import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return { ...original, after: vi.fn() };
});

const root = mkdtempSync(join(tmpdir(), "jarela-test-pending-approval-"));
process.env.JARELA_DB_DIR = root;
const { closeDb, getDb } = await import("@/lib/db");
const { createPendingAction, getPendingAction } = await import("@/lib/stores/pending-actions");
const { POST } = await import("@/app/api/v1/pending-actions/[id]/approve/route");
const { POST: deny } = await import("@/app/api/v1/pending-actions/[id]/deny/route");
const { GET } = await import("@/app/api/v1/pending-actions/route");

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

const payload = {
  question: "Choose output",
  options: [{ value: "brief", label: "Brief" }, { value: "full", label: "Full" }],
};
function seed() {
  return createPendingAction({ agent_id: "synthetic-agent", kind: "ask_choice", payload, reason: "Synthetic question" });
}
function request(body: string) {
  return new NextRequest("http://localhost/api/v1/pending-actions/example/approve", {
    method: "POST", body, headers: { "Content-Type": "application/json" },
  });
}

describe("shared approval endpoint for choice answers", () => {
  it("accepts an answer without Content-Length and persists it once", async () => {
    const action = seed();
    const req = request(JSON.stringify({ extras: { selected_values: ["full"] } }));
    expect(req.headers.has("content-length")).toBe(false);
    const context = { params: Promise.resolve({ id: action.id }) };
    const response = await POST(req, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ payload, result: { selected_values: ["full"] } });
    expect(getPendingAction(action.id)).toMatchObject({
      status: "approved", result: JSON.stringify({ selected_values: ["full"] }),
    });

    const repeat = await POST(request(JSON.stringify({ extras: { selected_values: ["brief"] } })), context);
    expect(repeat.status).toBe(409);
    expect(getPendingAction(action.id)?.result).toBe(JSON.stringify({ selected_values: ["full"] }));
  });

  it("uses the same decoded response shape for listing and denying a request", async () => {
    const action = seed();
    const list = GET(new NextRequest("http://localhost/api/v1/pending-actions?status=pending"));
    expect(await list.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: action.id, payload, result: null })]));
    const result = await deny(request("{}"), { params: Promise.resolve({ id: action.id }) });
    expect(await result.json()).toMatchObject({ id: action.id, status: "denied", payload, result: "user denied" });
  });

  it("rejects malformed stored JSON without reserving or executing a proposal", async () => {
    const action = seed();
    getDb().prepare("UPDATE pending_actions SET payload=? WHERE id=?").run("{broken", action.id);
    const response = await POST(request("{}"), { params: Promise.resolve({ id: action.id }) });
    expect(response.status).toBe(400);
    expect(getPendingAction(action.id)?.status).toBe("pending");
  });

  it.each([
    "not-json", "{}", JSON.stringify({ extras: { selected_values: [] } }),
    JSON.stringify({ extras: { selected_values: ["invented"] } }),
  ])("rejects invalid answers without consuming the pending request: %s", async (body) => {
    const action = seed();
    const result = await POST(request(body), { params: Promise.resolve({ id: action.id }) });
    expect(result.status).toBe(400);
    expect(getPendingAction(action.id)?.status).toBe("pending");
  });
});
