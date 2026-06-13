import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-packages-route-"));
const packagesDir = join(tmpRoot, "packages");
const manifestsDir = join(packagesDir, "manifests");
const moduleDir = join(packagesDir, "node_modules", "fake-pkg-for-route");
mkdirSync(manifestsDir, { recursive: true });
mkdirSync(moduleDir, { recursive: true });
writeFileSync(
  join(moduleDir, "package.json"),
  JSON.stringify({ name: "fake-pkg-for-route", main: "index.cjs" }),
);
writeFileSync(
  join(moduleDir, "index.cjs"),
  `class FakeRouteTool {
    constructor(args) { this.args = args || {}; }
    get name() { return "fake_route_tool"; }
    get description() { return "Fake tool for route tests"; }
    get schema() { return { _def: { typeName: "ZodObject" } }; }
    async invoke() { return "ok"; }
  }
  module.exports = { FakeRouteTool };`,
);

process.env.JARELA_DB_DIR = tmpRoot;
process.env.JARELA_PACKAGES_DIR = packagesDir;

const { _resetLangChainPackages } = await import("@/lib/tools/langchain-packages");
const { GET } = await import("@/app/api/v1/packages/route");
const { POST } = await import("@/app/api/v1/packages/reload/route");

beforeEach(() => {
  _resetLangChainPackages();
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("GET /api/v1/packages", () => {
  it("returns the packages dir and load result", async () => {
    writeFileSync(
      join(manifestsDir, "fake.json"),
      JSON.stringify({
        package: "fake-pkg-for-route",
        export: "FakeRouteTool",
        category: "Web",
        capability: "read",
      }),
    );

    const res = await GET();
    expect(res.ok).toBe(true);
    const body = await res.json() as {
      packagesDir: string;
      registered: string[];
      skipped: { manifest: string; reason: string }[];
      errors: { manifest: string; error: string }[];
    };
    expect(body.packagesDir).toBe(packagesDir);
    expect(body.registered).toContain("fake_route_tool");
    expect(body.errors).toEqual([]);
  });

  it("surfaces schema errors per manifest", async () => {
    writeFileSync(
      join(manifestsDir, "fake.json"),
      JSON.stringify({ package: "fake-pkg-for-route" }),
    );

    const res = await GET();
    const body = await res.json() as {
      registered: string[];
      errors: { manifest: string; error: string }[];
    };
    expect(body.registered).toEqual([]);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0]?.manifest).toBe("fake.json");
  });
});

describe("POST /api/v1/packages/reload", () => {
  it("reloads manifests and reflects new contents", async () => {
    // First load: no manifests.
    rmSync(manifestsDir, { recursive: true, force: true });
    mkdirSync(manifestsDir, { recursive: true });
    const first = await GET();
    const firstBody = await first.json() as { registered: string[] };
    expect(firstBody.registered).toEqual([]);

    // Add a manifest, then reload.
    writeFileSync(
      join(manifestsDir, "fake.json"),
      JSON.stringify({
        package: "fake-pkg-for-route",
        export: "FakeRouteTool",
        category: "Web",
        capability: "read",
      }),
    );
    const reloaded = await POST();
    expect(reloaded.ok).toBe(true);
    const reloadedBody = await reloaded.json() as { registered: string[] };
    expect(reloadedBody.registered).toContain("fake_route_tool");
  });
});
