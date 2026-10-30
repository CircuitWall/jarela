import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resolve } from "node:path";

const mocks = vi.hoisted(() => ({ create: vi.fn(), find: vi.fn(), stat: vi.fn(), notify: vi.fn() }));
vi.mock("@/lib/stores/document-sources", () => ({
  createDocumentSource: mocks.create, getDocumentSourceByPath: mocks.find,
  getDocumentSourceStats: () => ({}), listDocumentSources: () => [],
}));
vi.mock("@/lib/triggers", () => ({ notifyTriggerHandlers: mocks.notify }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, promises: { ...actual.promises, stat: mocks.stat } };
});
import { POST } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockImplementation((input) => ({ ...input, id: "source", enabled: 1, config: JSON.stringify(input.config) }));
  mocks.stat.mockResolvedValue({ isDirectory: () => true });
});

describe("source creation write boundary", () => {
  function local(body: unknown) {
    return new NextRequest("http://localhost/api/v1/documents/sources", {
      method: "POST", body: JSON.stringify(body),
    });
  }

  it("normalizes local input and notifies exactly once after creation", async () => {
    const response = await POST(local({ kind: "local_folder", path: "synthetic-folder", label: null }));
    expect(response.status).toBe(201);
    expect(mocks.stat).toHaveBeenCalledWith(resolve("synthetic-folder"));
    expect(mocks.find).toHaveBeenCalledWith(resolve("synthetic-folder"));
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({ path: resolve("synthetic-folder"), label: null });
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith("source_changed");
    expect(mocks.create.mock.invocationCallOrder[0]).toBeLessThan(mocks.notify.mock.invocationCallOrder[0]);
  });

  it("keeps local conflict wording without creating or notifying", async () => {
    mocks.find.mockReturnValueOnce({ id: "existing" });
    const response = await POST(local({ path: "synthetic-folder" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "source already exists for this path" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid input", { path: "" }, "invalid"],
    ["non-directory", { path: "synthetic-file" }, "path is not a directory"],
    ["unreadable", { path: "synthetic-absent" }, "path does not exist or is unreadable"],
  ])("rejects %s local sources before lookup, creation, or notification", async (mode, body, error) => {
    if (mode === "non-directory") mocks.stat.mockResolvedValueOnce({ isDirectory: () => false });
    if (mode === "unreadable") mocks.stat.mockRejectedValueOnce(new Error("synthetic missing path"));
    const response = await POST(local(body));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(mode === "invalid input" ? "string" : error);
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("does not claim success when post-create notification fails", async () => {
    mocks.notify.mockRejectedValueOnce(new Error("Synthetic notification failure"));
    await expect(POST(local({ path: "synthetic-folder" }))).rejects.toThrow("Synthetic notification failure");
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledOnce();
  });
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
    const response = await POST(request("icloud_mail", { scope: "inbox" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "source already exists for this config" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("preserves the error response for malformed JSON", async () => {
    const response = await POST(new NextRequest("http://localhost/api/v1/documents/sources", {
      method: "POST",
      body: "{",
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid json" });
  });
});
