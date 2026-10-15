import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-provider-models-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { upsertModelConfig, deleteModelConfig } = await import("@/lib/stores/model-config");
const { GET } = await import("./route");

const params = { params: Promise.resolve({ provider: "github-copilot" }) };
const request = () => new NextRequest("http://localhost/api/v1/providers/github-copilot/models?fresh=1");

afterEach(() => {
  deleteModelConfig("copilot-config");
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe("provider model catalogs", () => {
  it("rejects a retired PAT config as a configuration error", async () => {
    upsertModelConfig("copilot-config", "github-copilot", "gpt-4o", {
      api_key: "github_pat_synthetic",
    }, true);

    const response = await GET(request(), params);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/PAT.*GitHub Models.*retired/i),
    });
  });

  it("ignores a GITHUB_TOKEN PAT and returns the curated Copilot list", async () => {
    upsertModelConfig("copilot-config", "github-copilot", "gpt-4o", {}, true);
    vi.stubEnv("GITHUB_TOKEN", "ghp_synthetic");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const response = await GET(request(), params);

    expect(response.status).toBe(200);
    const models = await response.json() as Array<{ id: string }>;
    expect(models.length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});