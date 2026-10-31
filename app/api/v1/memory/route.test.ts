import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-memory-route-"));
process.env.JARELA_DB_DIR = tmpRoot;
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { GET, POST } = await import("./route");
const { PUT } = await import("./[namespace]/[key]/route");
const { putMemory, listMemory, deleteMemory } = await import("@/lib/stores/memory");

beforeEach(() => {
  for (const row of listMemory(undefined, undefined, 1000)) deleteMemory(row.namespace, row.key);
});

const get = (query: string) => GET(new NextRequest(`http://localhost/api/v1/memory${query}`));

describe("GET /api/v1/memory", () => {
  it("lists newest first without a search term", async () => {
    putMemory("facts", "a", JSON.stringify("first"));
    putMemory("facts", "b", JSON.stringify("second"));

    const items = await (await get("?namespace=facts")).json() as Array<{ key: string }>;

    expect(items.map((i) => i.key).sort()).toEqual(["a", "b"]);
  });

  describe("memory write contracts", () => {
    const request = (body: unknown, method: "POST" | "PUT") => new NextRequest("http://localhost/api/v1/memory", {
      method, body: JSON.stringify(body), headers: { "content-type": "application/json" },
    });
    const context = { params: Promise.resolve({ namespace: "facts", key: "write-contract" }) };

    it.each(["POST", "PUT"] as const)("rejects a missing value before persistence (%s)", async (method) => {
      const req = request({ namespace: "facts", key: "write-contract" }, method);
      const response = method === "POST" ? await POST(req) : await PUT(req, context);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid input: expected nonoptional, received undefined" });
      expect(listMemory("facts")).toHaveLength(0);
    });

    it("preserves create validation's identifier-first error order", async () => {
      const response = await POST(request({ namespace: "", key: "" }, "POST"));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "namespace required" });
    });

    it.each([null, false, 0, "", [], { nested: ["value", null] }])("preserves JSON value %j across create and update", async (value) => {
      const created = await POST(request({ namespace: "facts", key: "write-contract", value }, "POST"));
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ namespace: "facts", key: "write-contract", value });
      const updated = await PUT(request({ value }, "PUT"), context);
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({ namespace: "facts", key: "write-contract", value });
    });

    it("preserves existing API identifier spelling and ignores unknown body fields", async () => {
      const response = await POST(request({ namespace: " legacy ", key: " key ", value: true, ignored: "field" }, "POST"));
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ namespace: " legacy ", key: " key ", value: true });
    });

    it.each(["POST", "PUT"] as const)("keeps protected memory namespaces blocked (%s)", async (method) => {
      const body = { namespace: "app-settings", key: "skill_execution_policy", value: {} };
      const response = method === "POST"
        ? await POST(request(body, method))
        : await PUT(request(body, method), { params: Promise.resolve(body) });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Use Security settings to change skill execution policy" });
    });
  });

  it("searches by exact text and keeps the namespace filter", async () => {
    putMemory("facts", "deploy", JSON.stringify("the deploy key rotates monthly"));
    putMemory("other", "deploy-note", JSON.stringify("the deploy key lives elsewhere"));

    const all = await (await get("?search=deploy%20key")).json() as Array<{ namespace: string }>;
    const scoped = await (await get("?search=deploy%20key&namespace=facts")).json() as Array<{ namespace: string }>;

    expect(all.map((i) => i.namespace).sort()).toEqual(["facts", "other"]);
    expect(scoped.map((i) => i.namespace)).toEqual(["facts"]);
  });
});
