import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-env-route-"));
const originalDbDir = process.env.JARELA_DB_DIR;
const originalUsageStrategy = process.env.JARELA_USAGE_STRATEGY;
const originalRouterPolicy = process.env.JARELA_MODEL_ROUTER_POLICY;
const originalToolResultMaxBytes = process.env.JARELA_TOOL_RESULT_MAX_BYTES;
process.env.JARELA_DB_DIR = tmpRoot;

const { GET, PATCH, DELETE } = await import("./route");
const { readOverrides } = await import("@/lib/env/overrides");
const { resetConfigCache } = await import("@/lib/env/config");
const { getToolResultMaxBytes } = await import("@/lib/tools/support/result-refs");

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
  if (originalToolResultMaxBytes === undefined) delete process.env.JARELA_TOOL_RESULT_MAX_BYTES;
  else process.env.JARELA_TOOL_RESULT_MAX_BYTES = originalToolResultMaxBytes;
  resetConfigCache();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  delete process.env.JARELA_USAGE_STRATEGY;
  delete process.env.JARELA_MODEL_ROUTER_POLICY;
  delete process.env.JARELA_TOOL_RESULT_MAX_BYTES;
  resetConfigCache();
  const overrides = await readOverrides();
  const entries = { ...overrides.entries };
  delete entries.JARELA_USAGE_STRATEGY;
  delete entries.JARELA_MODEL_ROUTER_POLICY;
  delete entries.JARELA_TOOL_RESULT_MAX_BYTES;
  const { writeOverrides } = await import("@/lib/env/overrides");
  await writeOverrides({ version: 1, entries });
});

describe("GET /api/v1/env", () => {
  it("exposes preflight phase separately from restart requirements", async () => {
    const response = await GET();
    const { entries } = await response.json() as { entries: Array<{ name: string; phase: string; requiresRestart: boolean }> };
    const port = entries.find((entry) => entry.name === "JARELA_PORT");
    const runtimeRateLimits = entries.find((entry) => entry.name === "JARELA_PROVIDER_RATE_LIMITS");

    expect(port).toMatchObject({ phase: "preflight", requiresRestart: true });
    expect(runtimeRateLimits).toMatchObject({ phase: "postflight", requiresRestart: true });
  });
});

describe("PATCH /api/v1/env", () => {
  it("applies and removes the shared tool-result limit without restarting", async () => {
    expect(getToolResultMaxBytes()).toBe(16 * 1024);
    const response = await PATCH(patchRequest({
      name: "JARELA_TOOL_RESULT_MAX_BYTES", value: "32768",
    }));
    expect(response.status).toBe(200);
    expect(getToolResultMaxBytes()).toBe(32768);
    expect((await readOverrides()).entries.JARELA_TOOL_RESULT_MAX_BYTES).toBe("32768");
    const { entries } = await (await GET()).json() as {
      entries: Array<{ name: string; current: string; requiresRestart: boolean }>;
    };
    expect(entries.find((entry) => entry.name === "JARELA_TOOL_RESULT_MAX_BYTES"))
      .toMatchObject({ current: "32768", requiresRestart: false });
    const removed = await DELETE(new NextRequest(
      "http://localhost/api/v1/env?name=JARELA_TOOL_RESULT_MAX_BYTES",
      { method: "DELETE" },
    ));
    expect(removed.status).toBe(200);
    expect(getToolResultMaxBytes()).toBe(16 * 1024);
    expect((await readOverrides()).entries.JARELA_TOOL_RESULT_MAX_BYTES).toBeUndefined();
  });

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
