import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  inventory: vi.fn(),
  save: vi.fn(),
  start: vi.fn(),
  source: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/documents/lifecycle", () => ({
  readDocumentIndexLifecycleState: mocks.state,
  getDocumentIndexInventory: mocks.inventory,
  saveDocumentIndexLifecycleSettings: mocks.save,
  startDocumentIndexMaintenance: mocks.start,
}));
vi.mock("@/lib/stores/document-sources", () => ({ getDocumentSource: mocks.source }));

import { GET, PATCH, POST } from "./route";

const status = {
  running: false, action: null, started_at: null, finished_at: null, summary: null, error: null,
};
const inventory = {
  document_count: 2, chunk_count: 4, size_bytes: 8192, free_bytes: 4096, auto_vacuum: "incremental",
};
const state = { settings: { purge_disabled_after_days: 0 }, inventory, status };

function request(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/documents/lifecycle", {
    method,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.mockResolvedValue(state);
  mocks.inventory.mockResolvedValue(inventory);
  mocks.save.mockReturnValue({ purge_disabled_after_days: 30 });
  mocks.source.mockReturnValue({ id: "source" });
  mocks.start.mockReturnValue({
    started: true,
    status: { ...status, running: true, action: "purge_source" },
  });
});

describe("document index lifecycle route", () => {
  it("returns settings, inventory, and maintenance status", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(state);
  });

  it("persists a bounded retention patch", async () => {
    const response = await PATCH(request("PATCH", { purge_disabled_after_days: 30 }));
    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith({ purge_disabled_after_days: 30 });
    expect(await response.json()).toEqual(state);
  });

  it.each([-1, 3651, 1.5, "30"])("rejects out-of-range retention %s", async (days) => {
    const response = await PATCH(request("PATCH", { purge_disabled_after_days: days }));
    expect(response.status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before dispatch", async () => {
    const response = await PATCH(request("PATCH", "{"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Request body must be valid JSON" });
  });

  it("rejects an unknown purge target without starting maintenance", async () => {
    mocks.source.mockReturnValue(null);
    const response = await POST(request("POST", { action: "purge_source", source_id: "missing" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("refuses incremental reclaim before the database has been compacted once", async () => {
    mocks.inventory.mockResolvedValue({ ...inventory, auto_vacuum: "none" });
    const response = await POST(request("POST", { action: "reclaim" }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("compaction");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation for the full compaction", async () => {
    const response = await POST(request("POST", { action: "vacuum" }));
    expect(response.status).toBe(400);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("accepts the supported actions with 202 and reports a busy conflict", async () => {
    const rewrite = await POST(request("POST", { action: "rewrite_embeddings" }));
    expect(rewrite.status).toBe(202);
    expect(mocks.start).toHaveBeenCalledWith({ action: "rewrite_embeddings" });

    const accepted = await POST(request("POST", { action: "purge_source", source_id: "source" }));
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ accepted: true });
    expect(mocks.start).toHaveBeenCalledWith({ action: "purge_source", source_id: "source" });

    mocks.start.mockReturnValue({ started: false, status });
    const conflict = await POST(request("POST", { action: "vacuum", confirm: true }));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toContain("already running");
  });
});
