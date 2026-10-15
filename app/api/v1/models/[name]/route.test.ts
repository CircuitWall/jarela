import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-model-route-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { upsertModelConfig, deleteModelConfig, listModelConfigs, getModelConfig } = await import("@/lib/stores/model-config");
const { PATCH, PUT } = await import("./route");

const ctx = (name: string) => ({ params: Promise.resolve({ name }) });
const json = (method: string, name: string, body: unknown) => new NextRequest(
  `http://localhost/api/v1/models/${name}`,
  { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
);
const defaults = () => listModelConfigs().filter((r) => r.is_default === 1).map((r) => r.name);

afterEach(() => {
  for (const r of listModelConfigs()) deleteModelConfig(r.name);
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe("PATCH /api/v1/models/[name]", () => {
  it("switches the default without touching params", async () => {
    upsertModelConfig("alpha", "anthropic", "claude-x", { temperature: 0.1 }, true);
    upsertModelConfig("beta", "anthropic", "claude-y", { temperature: 0.7 }, false);
    const before = getModelConfig("beta")!.params;

    const res = await PATCH(json("PATCH", "beta", { is_default: true }), ctx("beta"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ name: "beta", is_default: true, enabled: true });
    expect(defaults()).toEqual(["beta"]);
    expect(getModelConfig("beta")!.params).toBe(before);
  });

  it("disables a model and promotes another default atomically", async () => {
    upsertModelConfig("alpha", "anthropic", "claude-x", {}, true);
    upsertModelConfig("beta", "anthropic", "claude-y", {}, false);

    const res = await PATCH(json("PATCH", "alpha", { enabled: false }), ctx("alpha"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ enabled: false, is_default: false });
    expect(defaults()).toEqual(["beta"]);
  });

  it("re-enables and sets default in one request", async () => {
    upsertModelConfig("alpha", "anthropic", "claude-x", {}, true);
    upsertModelConfig("beta", "anthropic", "claude-y", {}, false);
    await PATCH(json("PATCH", "beta", { enabled: false }), ctx("beta"));

    const res = await PATCH(json("PATCH", "beta", { enabled: true, is_default: true }), ctx("beta"));

    expect(res.status).toBe(200);
    expect(defaults()).toEqual(["beta"]);
  });

  it("returns 409 when disabling the last enabled model and 404 for unknown models", async () => {
    upsertModelConfig("solo", "anthropic", "claude-x", {}, true);

    expect((await PATCH(json("PATCH", "solo", { enabled: false }), ctx("solo"))).status).toBe(409);
    expect(getModelConfig("solo")!.enabled).toBe(1);
    expect((await PATCH(json("PATCH", "ghost", { is_default: true }), ctx("ghost"))).status).toBe(404);
  });

  it("rejects empty, contradictory, and unknown-field bodies", async () => {
    upsertModelConfig("solo", "anthropic", "claude-x", {}, true);
    for (const body of [{}, { enabled: false, is_default: true }, { is_default: false }, { params: {} }]) {
      expect((await PATCH(json("PATCH", "solo", body), ctx("solo"))).status).toBe(400);
    }
  });
});

describe("PUT /api/v1/models/[name]", () => {
  it("keeps the default flag when is_default is omitted", async () => {
    upsertModelConfig("alpha", "anthropic", "claude-x", {}, true);

    const res = await PUT(json("PUT", "alpha", { provider: "anthropic", model_id: "claude-x", params: { temperature: 0.3 } }), ctx("alpha"));

    expect(res.status).toBe(200);
    expect(defaults()).toEqual(["alpha"]);
  });
});