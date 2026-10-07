import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-env-route-"));
const originalDbDir = process.env.JARELA_DB_DIR;
const originalUsageStrategy = process.env.JARELA_USAGE_STRATEGY;
const originalRouterPolicy = process.env.JARELA_MODEL_ROUTER_POLICY;
process.env.JARELA_DB_DIR = tmpRoot;

const { PATCH } = await import("./route");
const { readOverrides } = await import("@/lib/env/overrides");

function patchRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/env", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  if (originalDbDir === undefined) delete process.env.JARELA_DB_DIR;
  else process.env.JARELA_DB_DIR = originalDbDir;
  if (originalUsageStrategy === undefined) delete process.env.JARELA_USAGE_STRATEGY;
  else process.env.JARELA_USAGE_STRATEGY = originalUsageStrategy;
  if (originalRouterPolicy === undefined) delete process.env.JARELA_MODEL_ROUTER_POLICY;
  else process.env.JARELA_MODEL_ROUTER_POLICY = originalRouterPolicy;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  delete process.env.JARELA_USAGE_STRATEGY;
  delete process.env.JARELA_MODEL_ROUTER_POLICY;
  const overrides = await readOverrides();
  const entries = { ...overrides.entries };
  delete entries.JARELA_USAGE_STRATEGY;
  delete entries.JARELA_MODEL_ROUTER_POLICY;
  const { writeOverrides } = await import("@/lib/env/overrides");
  await writeOverrides({ version: 1, entries });
});

describe("PATCH /api/v1/env", () => {
  it("persists and applies a batch of env updates together", async () => {
    const response = await PATCH(patchRequest({
      updates: [
        { name: "JARELA_USAGE_STRATEGY", value: "fast" },
        { name: "JARELA_MODEL_ROUTER_POLICY", value: "fast" },
      ],
    }));

    expect(response.status).toBe(200);
    expect(process.env.JARELA_USAGE_STRATEGY).toBe("fast");
    expect(process.env.JARELA_MODEL_ROUTER_POLICY).toBe("fast");
    expect((await readOverrides()).entries).toMatchObject({
      JARELA_USAGE_STRATEGY: "fast",
      JARELA_MODEL_ROUTER_POLICY: "fast",
    });
  });

  it("rejects an invalid batch without persisting any update", async () => {
    const response = await PATCH(patchRequest({
      updates: [
        { name: "JARELA_USAGE_STRATEGY", value: "cost_saving" },
        { name: "JARELA_MODEL_ROUTER_POLICY", value: "invalid" },
      ],
    }));

    expect(response.status).toBe(400);
    expect(process.env.JARELA_USAGE_STRATEGY).toBeUndefined();
    expect(process.env.JARELA_MODEL_ROUTER_POLICY).toBeUndefined();
    expect((await readOverrides()).entries).not.toHaveProperty("JARELA_USAGE_STRATEGY");
    expect((await readOverrides()).entries).not.toHaveProperty("JARELA_MODEL_ROUTER_POLICY");
  });
});
