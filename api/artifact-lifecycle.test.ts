import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-artifact-lifecycle-route-"));
process.env.JARELA_DB_DIR = tmpRoot;

const route = await import("@/app/api/v1/artifacts/lifecycle/route");
const files = await import("@/lib/files");
const db = await import("@/lib/db");

function getReq(): Request {
  return new Request("http://localhost:4312/api/v1/artifacts/lifecycle", {
    method: "GET",
    headers: { "content-type": "application/json" },
  });
}

function postReq(body: unknown): Request {
  return new Request("http://localhost:4312/api/v1/artifacts/lifecycle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchReq(body: unknown): Request {
  return new Request("http://localhost:4312/api/v1/artifacts/lifecycle", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  db.closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("/api/v1/artifacts/lifecycle", () => {
  it("returns settings and artifact inventory", async () => {
    files.writeTextFile("browser-extract-route.txt", "hello");
    const res = route.GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.retention_days).toBe(30);
    expect(body.inventory.total_files).toBeGreaterThanOrEqual(1);
  });

  it("updates lifecycle settings", async () => {
    const res = await route.PATCH(patchReq({
      retention_days: 7,
      max_total_mb: 128,
      include_generated_media: false,
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toMatchObject({
      retention_days: 7,
      max_total_mb: 128,
      include_generated_media: false,
    });
  });

  it("cleans artifacts using the saved policy", async () => {
    files.writeTextFile("browser-extract-route-old.txt", "old");
    const old = new Date(Date.now() - 20 * 86_400_000);
    utimesSync(join(files.FILES_DIR, "browser-extract-route-old.txt"), old, old);

    const res = await route.POST(postReq({ dry_run: false }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.deleted.map((file: { name: string }) => file.name)).toContain("browser-extract-route-old.txt");
  });

  it("rejects invalid settings", async () => {
    const res = await route.PATCH(patchReq({ retention_days: 0 }));
    expect(res.status).toBe(400);
  });
});
