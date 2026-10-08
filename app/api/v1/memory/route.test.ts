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

const { GET } = await import("./route");
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

  it("searches by exact text and keeps the namespace filter", async () => {
    putMemory("facts", "deploy", JSON.stringify("the deploy key rotates monthly"));
    putMemory("other", "deploy-note", JSON.stringify("the deploy key lives elsewhere"));

    const all = await (await get("?search=deploy%20key")).json() as Array<{ namespace: string }>;
    const scoped = await (await get("?search=deploy%20key&namespace=facts")).json() as Array<{ namespace: string }>;

    expect(all.map((i) => i.namespace).sort()).toEqual(["facts", "other"]);
    expect(scoped.map((i) => i.namespace)).toEqual(["facts"]);
  });
});
