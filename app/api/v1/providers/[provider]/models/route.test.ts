import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-provider-models-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { upsertModelConfig, deleteModelConfig } = await import("@/lib/stores/model-config");
const { GET, POST } = await import("./route");

const routeParams = (provider: string) => ({ params: Promise.resolve({ provider }) });
const request = (provider: string, fresh = true) =>
  new NextRequest(`http://localhost/api/v1/providers/${provider}/models${fresh ? "?fresh=1" : ""}`);

afterEach(() => {
  for (const name of ["copilot-config", "anthropic-config", "gemini-config", "deepseek-config"]) {
    deleteModelConfig(name);
  }
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

    const response = await GET(request("github-copilot"), routeParams("github-copilot"));

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

    const response = await GET(request("github-copilot"), routeParams("github-copilot"));

    expect(response.status).toBe(200);
    const models = await response.json() as Array<{ id: string }>;
    expect(models.length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("loads the Anthropic catalog and follows its pagination cursor", async () => {
    upsertModelConfig("anthropic-config", "anthropic", "claude-sonnet-4-6", {
      api_key: "synthetic-anthropic-key",
    }, true);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          id: "claude-first",
          max_input_tokens: 500000,
          max_tokens: 64000,
          capabilities: {
            image_input: { supported: true },
            structured_outputs: { supported: true },
          },
        }],
        has_more: true,
        last_id: "claude-first",
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "claude-second" }],
        has_more: false,
        last_id: "claude-second",
      })));
    vi.stubGlobal("fetch", fetch);

    const response = await GET(request("anthropic"), routeParams("anthropic"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject([
      {
        id: "claude-first",
        hosted_on: "anthropic",
        context_length: 500000,
        max_output_tokens: 64000,
        capabilities: { vision: true, json_mode: true },
      },
      { id: "claude-second", hosted_on: "anthropic" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0][0])).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(String(fetch.mock.calls[1][0])).toContain("after_id=claude-first");
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
      "x-api-key": "synthetic-anthropic-key",
      "anthropic-version": "2023-06-01",
    });
  });

  it("loads Gemini generation models with live limits and skips embedding-only models", async () => {
    upsertModelConfig("gemini-config", "gemini", "gemini-2.5-flash", {
      api_key: "synthetic-gemini-key",
    }, true);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [
        {
          name: "models/gemini-current",
          inputTokenLimit: 131072,
          outputTokenLimit: 16384,
          supportedGenerationMethods: ["generateContent"],
        },
        {
          name: "models/text-embedding-current",
          supportedGenerationMethods: ["embedContent"],
        },
      ],
    })));
    vi.stubGlobal("fetch", fetch);

    const response = await GET(request("gemini"), routeParams("gemini"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject([
      { id: "gemini-current", context_length: 131072, max_output_tokens: 16384 },
    ]);
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
      "x-goog-api-key": "synthetic-gemini-key",
    });
  });

  it("loads DeepSeek models with live limits and modality capabilities", async () => {
    upsertModelConfig("deepseek-config", "deepseek", "deepseek-flash", {
      api_key: "synthetic-deepseek-key",
    }, true);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{
        id: "deepseek-new",
        context_window: 900000,
        max_output_tokens: 120000,
        input_modalities: ["text", "image"],
      }],
    })));
    vi.stubGlobal("fetch", fetch);

    const response = await GET(request("deepseek"), routeParams("deepseek"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject([
      {
        id: "deepseek-new",
        context_length: 900000,
        max_output_tokens: 120000,
        capabilities: { vision: true, files: true },
      },
    ]);
    expect(String(fetch.mock.calls[0][0])).toBe("https://api.deepseek.com/models");
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: "Bearer synthetic-deepseek-key",
    });
  });

  it("uses unsaved credentials and base URLs for OpenAI catalog discovery", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "gpt-live-catalog-model" }],
    })));
    vi.stubGlobal("fetch", fetch);
    const req = new NextRequest("http://localhost/api/v1/providers/openai/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        params: {
          api_key: "synthetic-openai-key",
          base_url: "https://openai.example/v1",
        },
      }),
    });

    const response = await POST(req, routeParams("openai"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject([
      { id: "gpt-live-catalog-model" },
    ]);
    expect(String(fetch.mock.calls[0][0])).toBe("https://openai.example/v1/models");
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: "Bearer synthetic-openai-key",
    });
  });

  it("rejects malformed catalog request bodies", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const req = new NextRequest("http://localhost/api/v1/providers/openai/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    const response = await POST(req, routeParams("openai"));

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("invalidates the cached fallback after credentialed catalog discovery", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const fetch = vi.fn().mockImplementation(() => new Response(JSON.stringify({
      data: [{ id: "claude-live-after-save" }],
      has_more: false,
      last_id: "claude-live-after-save",
    })));
    vi.stubGlobal("fetch", fetch);

    const fallbackResponse = await GET(request("anthropic"), routeParams("anthropic"));
    expect(fallbackResponse.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();

    const postRequest = new NextRequest("http://localhost/api/v1/providers/anthropic/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params: { api_key: "synthetic-anthropic-key" } }),
    });
    const liveResponse = await POST(postRequest, routeParams("anthropic"));
    expect(liveResponse.status).toBe(200);

    upsertModelConfig("anthropic-config", "anthropic", "claude-live-after-save", {
      api_key: "synthetic-anthropic-key",
    }, true);
    const nextResponse = await GET(request("anthropic", false), routeParams("anthropic"));

    expect(nextResponse.status).toBe(200);
    await expect(nextResponse.json()).resolves.toMatchObject([
      { id: "claude-live-after-save" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});