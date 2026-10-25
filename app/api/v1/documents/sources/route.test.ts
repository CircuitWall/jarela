import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ create: vi.fn(), find: vi.fn() }));
vi.mock("@/lib/stores/document-sources", () => ({
  createDocumentSource: mocks.create, getDocumentSourceByPath: mocks.find,
  getDocumentSourceStats: () => ({}), listDocumentSources: () => [],
}));
vi.mock("@/lib/triggers", () => ({ notifyTriggerHandlers: vi.fn() }));
import { POST } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockImplementation((input) => ({ ...input, id: "source", enabled: 1, config: JSON.stringify(input.config) }));
});

function request(kind: string, config: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/v1/documents/sources", {
    method: "POST", body: JSON.stringify({ kind, label: "Synthetic mail", config }),
  });
}

describe("mail source creation", () => {
  it.each(["gmail_mail", "outlook_mail", "icloud_mail"])("accepts query-free scopes for %s", async (kind) => {
    for (const config of [{ scope: "inbox" }, { scope: "all" }, { scope: "folder", folder: "synthetic" }]) {
      const response = await POST(request(kind, config));
      expect(response.status).toBe(201);
      expect((await response.json()).config).toEqual(config);
    }
  });

  it.each([
    {}, { scope: "bad" }, { scope: "folder" }, { scope: "folder", folder: " " },
    { scope: "inbox", max_results: 0 }, { scope: "inbox", max_results: 1.5 },
    { scope: "inbox", page_size: 101 }, { scope: "inbox", retention: "bad" },
  ])("rejects invalid mail settings: %j", async (config) => {
    const response = await POST(request("outlook_mail", config));
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("preserves legacy Gmail and Outlook query-only inputs", async () => {
    expect((await POST(request("gmail_mail", { query: "newer_than:30d" }))).status).toBe(201);
    expect((await POST(request("outlook_mail", { query: "budget" }))).status).toBe(201);
    expect((await POST(request("icloud_mail", { query: "budget" }))).status).toBe(400);
  });

  it("distinguishes scopes, folders, limits, and retention in source identities", async () => {
    const configs = [
      { scope: "inbox" }, { scope: "all" }, { scope: "folder", folder: "one" },
      { scope: "folder", folder: "two" }, { scope: "inbox", max_results: 1 },
      { scope: "inbox", retention: "mirror" },
    ];
    const paths = [];
    for (const config of configs) {
      const response = await POST(request("outlook_mail", config));
      paths.push((await response.json()).path);
    }
    expect(new Set(paths).size).toBe(configs.length);
  });

  it("rejects an existing source", async () => {
    mocks.find.mockReturnValueOnce({ id: "existing" });
    expect((await POST(request("icloud_mail", { scope: "inbox" }))).status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
