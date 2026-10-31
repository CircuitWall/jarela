import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { DocumentSourceRow } from "@/lib/stores/document-sources";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
  stats: vi.fn(), listWithStats: vi.fn(), find: vi.fn(), notify: vi.fn(),
}));
vi.mock("@/lib/stores/document-sources", () => ({
  listDocumentSources: mocks.list, getDocumentSource: mocks.get,
  createDocumentSource: mocks.create, updateDocumentSource: mocks.update,
  deleteDocumentSource: mocks.remove, getDocumentSourceStats: mocks.stats,
  getDocumentSourceByPath: mocks.find,
  listDocumentSourcesWithStats: mocks.listWithStats,
}));
vi.mock("@/lib/triggers", () => ({ notifyTriggerHandlers: mocks.notify }));
import { GET as list, POST as create } from "./route";
import { GET as get, PATCH as update, DELETE as remove } from "./[id]/route";

const row: DocumentSourceRow = {
  id: "synthetic", path: "github-repo://example/project", label: "Example", enabled: 1,
  last_scan_at: null, last_error: null, created_at: "2026-10-30T00:00:00Z",
  updated_at: "2026-10-30T01:00:00Z", kind: "github_repo",
  config: '{"owner":"example","repo":"project"}', last_cursor: "indexer-only",
};
const stats = { source_id: row.id, document_count: 2, chunk_count: 4, embedded_chunk_count: 3 };
const expected = {
  id: row.id, path: row.path, label: row.label, enabled: true,
  last_scan_at: null, last_error: null, created_at: row.created_at, updated_at: row.updated_at,
  kind: "github_repo", config: { owner: "example", repo: "project" }, stats,
};
function context() { return { params: Promise.resolve({ id: row.id }) }; }
function request(method = "GET", body?: unknown) {
  return new NextRequest("http://localhost/api/v1/documents/sources/synthetic", {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockReturnValue([row]);
  mocks.listWithStats.mockReturnValue([{ source: row, stats }]);
  mocks.get.mockReturnValue(row);
  mocks.create.mockReturnValue(row);
  mocks.update.mockReturnValue(row);
  mocks.remove.mockReturnValue(true);
  mocks.stats.mockReturnValue(stats);
});

describe("document source wire contracts", () => {
  it("uses the same complete resource shape in list, get, create, and patch", async () => {
    const collection = await list();
    expect(collection.status).toBe(200);
    expect(await collection.json()).toEqual([expected]);
    const item = await get(request(), context());
    expect(item.status).toBe(200);
    expect(await item.json()).toEqual(expected);
    const created = await create(request("POST", {
      kind: row.kind, label: row.label, config: { owner: "example", repo: "project" },
    }));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual(expected);
    const patched = await update(request("PATCH", { label: row.label }), context());
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual(expected);
    expect(mocks.listWithStats).toHaveBeenCalledOnce();
    expect(mocks.stats).toHaveBeenCalledTimes(3);
    expect(mocks.stats).toHaveBeenCalledWith(row.id);
    expect(mocks.notify).toHaveBeenCalledTimes(2);
  });

  it("preserves not-found statuses and wording without emitting change notifications", async () => {
    mocks.get.mockReturnValue(null);
    mocks.update.mockReturnValue(null);
    mocks.remove.mockReturnValue(false);
    for (const response of [
      await get(request(), context()),
      await update(request("PATCH", { enabled: false }), context()),
      await remove(request("DELETE"), context()),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
    }
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.stats).not.toHaveBeenCalled();
  });

  it("preserves the delete response rather than introducing a data envelope or 204", async () => {
    const response = await remove(request("DELETE"), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(mocks.notify).toHaveBeenCalledWith("source_changed");
  });

  it("validates patches before mutation", async () => {
    const response = await update(request("PATCH", { enabled: "yes" }), context());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
