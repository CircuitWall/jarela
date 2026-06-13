import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-pkg-install-route-"));
const packagesDir = join(tmpRoot, "packages");
mkdirSync(packagesDir, { recursive: true });
process.env.JARELA_DB_DIR = tmpRoot;
process.env.JARELA_PACKAGES_DIR = packagesDir;

const { _resetPackageInstallStore } = await import("@/lib/tools/package-install");
const { GET, POST } = await import("@/app/api/v1/packages/install/route");
const { DELETE } = await import("@/app/api/v1/packages/install/[id]/route");

beforeEach(() => {
  _resetPackageInstallStore();
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makePost(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/packages/install", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/v1/packages/install", () => {
  it("returns 202 + approvalId for a disallowed publisher", async () => {
    const res = await POST(makePost({ spec: "@untrusted/pkg" }));
    expect(res.status).toBe(202);
    const body = await res.json() as {
      status: string;
      approvalId: string;
      publisher: string;
      spec: string;
      reason: string;
    };
    expect(body.status).toBe("pending");
    expect(body.approvalId).toBeTypeOf("string");
    expect(body.publisher).toBe("@untrusted");
    expect(body.spec).toBe("@untrusted/pkg");
    expect(body.reason).toMatch(/allowlist/);
  });

  it("returns 400 on empty spec", async () => {
    const res = await POST(makePost({ spec: "" }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/packages/install", () => {
  it("lists pending approvals", async () => {
    await POST(makePost({ spec: "@untrusted/a" }));
    await POST(makePost({ spec: "@untrusted/b" }));
    const res = GET();
    const body = await res.json() as Array<{ spec: string }>;
    expect(body.map((p) => p.spec).sort()).toEqual(["@untrusted/a", "@untrusted/b"]);
  });
});

describe("DELETE /api/v1/packages/install/:id", () => {
  it("removes the pending approval", async () => {
    const post = await POST(makePost({ spec: "@untrusted/pkg" }));
    const { approvalId } = await post.json() as { approvalId: string };

    const req = new NextRequest(
      `http://localhost/api/v1/packages/install/${approvalId}`,
      { method: "DELETE" },
    );
    const res = await DELETE(req, { params: Promise.resolve({ id: approvalId }) });
    expect(res.status).toBe(200);

    const listRes = GET();
    expect(await listRes.json()).toEqual([]);
  });

  it("returns 404 for unknown id", async () => {
    const req = new NextRequest("http://localhost/api/v1/packages/install/missing", {
      method: "DELETE",
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
  });
});
