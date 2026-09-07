import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-memory-policy-"));
process.env.JARELA_DB_DIR = tmpRoot;

const route = await import("@/app/api/v1/memory/policy/route");

function patch(body: unknown): Request {
  return new Request("http://localhost/api/v1/memory/policy", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await route.PATCH(patch({ policy: "balanced" }));
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("memory policy route", () => {
  it("returns the default balanced policy", async () => {
    expect(await (await route.GET()).json()).toEqual({ policy: "balanced" });
  });

  it("persists a selected recall policy", async () => {
    expect(await (await route.PATCH(patch({ policy: "important" }))).json()).toEqual({ policy: "important" });
    expect(await (await route.GET()).json()).toEqual({ policy: "important" });
  });

  it("rejects unknown policy values", async () => {
    expect((await route.PATCH(patch({ policy: "everything" }))).status).toBe(400);
  });
});