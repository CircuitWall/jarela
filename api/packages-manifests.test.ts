import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-pkg-manifests-route-"));
const packagesDir = join(tmpRoot, "packages");
const moduleDir = join(packagesDir, "node_modules", "fake-route-manifest");
mkdirSync(join(packagesDir, "manifests"), { recursive: true });
mkdirSync(moduleDir, { recursive: true });
writeFileSync(
  join(moduleDir, "package.json"),
  JSON.stringify({ name: "fake-route-manifest", main: "index.cjs" }),
);
writeFileSync(
  join(moduleDir, "index.cjs"),
  `class FakeRouteManifestTool {
    constructor() {
      this.name = "fake_route_manifest_tool";
      this.description = "Tool for manifest route tests";
      this.schema = { _def: { typeName: "ZodObject" } };
    }
    async invoke() { return "ok"; }
  }
  module.exports = { FakeRouteManifestTool };`,
);

process.env.JARELA_DB_DIR = tmpRoot;
process.env.JARELA_PACKAGES_DIR = packagesDir;

const { _resetLangChainPackages } = await import("@/lib/tools/langchain-packages");
const { _wipeManifests } = await import("@/lib/tools/package-manifests");
const list = await import("@/app/api/v1/packages/manifests/route");
const item = await import("@/app/api/v1/packages/manifests/[name]/route");

beforeEach(() => {
  _wipeManifests();
  _resetLangChainPackages();
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function postJson(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function putJson(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/v1/packages/manifests", () => {
  it("creates a manifest, loads the tool, returns 201", async () => {
    const res = await list.POST(postJson("http://localhost/api/v1/packages/manifests", {
      name: "fake",
      package: "fake-route-manifest",
      export: "FakeRouteManifestTool",
      category: "Web",
      capability: "read",
    }));
    expect(res.status).toBe(201);
    const body = await res.json() as { record: { name: string }; load: { registered: string[] } };
    expect(body.record.name).toBe("fake");
    expect(body.load.registered).toContain("fake_route_manifest_tool");
  });

  it("returns 409 on duplicate", async () => {
    const make = () => list.POST(postJson("http://localhost/api/v1/packages/manifests", {
      name: "dup",
      package: "fake-route-manifest",
      export: "FakeRouteManifestTool",
      category: "Web",
    }));
    expect((await make()).status).toBe(201);
    expect((await make()).status).toBe(409);
  });

  it("returns 400 on invalid input", async () => {
    const res = await list.POST(postJson("http://localhost/api/v1/packages/manifests", {
      name: "bad",
      package: "fake-route-manifest",
      category: "NotARealCategory",
    }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/packages/manifests", () => {
  it("lists created manifests", async () => {
    await list.POST(postJson("http://localhost/api/v1/packages/manifests", {
      name: "a",
      package: "fake-route-manifest",
      export: "FakeRouteManifestTool",
      category: "Web",
    }));
    const res = list.GET();
    const body = await res.json() as Array<{ name: string }>;
    expect(body.map((r) => r.name)).toEqual(["a"]);
  });
});

describe("PUT /api/v1/packages/manifests/:name", () => {
  it("upserts a manifest", async () => {
    const res = await item.PUT(
      putJson("http://localhost/api/v1/packages/manifests/upserted", {
        package: "fake-route-manifest",
        export: "FakeRouteManifestTool",
        category: "Web",
        capability: "write",
      }),
      { params: Promise.resolve({ name: "upserted" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { record: { manifest: { capability: string } } };
    expect(body.record.manifest.capability).toBe("write");
  });
});

describe("GET /api/v1/packages/manifests/:name", () => {
  it("returns 404 for unknown name", async () => {
    const res = await item.GET(
      new NextRequest("http://localhost/api/v1/packages/manifests/missing"),
      { params: Promise.resolve({ name: "missing" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns the manifest on hit", async () => {
    await list.POST(postJson("http://localhost/api/v1/packages/manifests", {
      name: "hit",
      package: "fake-route-manifest",
      export: "FakeRouteManifestTool",
      category: "Web",
    }));
    const res = await item.GET(
      new NextRequest("http://localhost/api/v1/packages/manifests/hit"),
      { params: Promise.resolve({ name: "hit" }) },
    );
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/v1/packages/manifests/:name", () => {
  it("removes the manifest", async () => {
    await list.POST(postJson("http://localhost/api/v1/packages/manifests", {
      name: "byebye",
      package: "fake-route-manifest",
      export: "FakeRouteManifestTool",
      category: "Web",
    }));
    const res = await item.DELETE(
      new NextRequest("http://localhost/api/v1/packages/manifests/byebye", { method: "DELETE" }),
      { params: Promise.resolve({ name: "byebye" }) },
    );
    expect(res.status).toBe(200);

    const listRes = list.GET();
    expect(await listRes.json()).toEqual([]);
  });

  it("returns 404 for unknown name", async () => {
    const res = await item.DELETE(
      new NextRequest("http://localhost/api/v1/packages/manifests/nope", { method: "DELETE" }),
      { params: Promise.resolve({ name: "nope" }) },
    );
    expect(res.status).toBe(404);
  });
});
