import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  config: { pricingLlmExtract: true, pricingExtractorModel: "" },
}));
vi.mock("@/lib/env/config", () => ({ getConfig: () => mocks.config }));
vi.mock("@/lib/providers", () => ({ getProvider: () => ({ invoke: mocks.invoke }) }));
vi.mock("@/lib/stores/model-config", () => ({
  getDefaultModelConfig: () => ({ provider: "mock", model_id: "extractor" }),
  getModelConfig: () => ({ provider: "mock", model_id: "extractor" }),
  getModelParams: () => ({}),
}));
const root = mkdtempSync(join(tmpdir(), "jarela-model-updates-"));
process.env.JARELA_DB_DIR = root;
const { getDb } = await import("@/lib/db");
const { parseModelUpdates, refreshModelUpdates, MODEL_UPDATE_SOURCES } = await import("./model-updates");
const { listModelMetadata, saveModelMetadata, resolvedModelMetadata } = await import("@/lib/stores/model-metadata");
const checkedAt = "2026-10-25T10:00:00.000Z";
const sourceUrl = "https://api-docs.deepseek.com/";
const page = "deepseek-flash now uses Flash-1017. deepseek-flash supports image input. The Search API is available to API developers.";
const extraction = {
  models: [{
    model_id: "deepseek-flash",
    version: { value: "Flash-1017", evidence: "deepseek-flash now uses Flash-1017." },
    capabilities: { vision: { value: true, evidence: "deepseek-flash supports image input." } },
  }],
  provider_features: [{ feature: "web_search", evidence: "The Search API is available to API developers." }],
};

beforeEach(() => {
  getDb().prepare("DELETE FROM memory_store WHERE namespace IN ('model-metadata','provider-api-features')").run();
  mocks.config.pricingLlmExtract = true;
  mocks.invoke.mockReset().mockResolvedValue({ text: JSON.stringify(extraction) });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html>${page}</html>`)));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* SQLite may still hold files on Windows. */ } });

describe("source-backed model updates", () => {
  it("validates exact model/version/capability evidence and separates standalone APIs", () => {
    const result = parseModelUpdates(JSON.stringify(extraction), page, "deepseek", sourceUrl, checkedAt);
    expect(result.models).toEqual([{
      provider: "deepseek", model_id: "deepseek-flash",
      version: { ...extraction.models[0].version, source_url: sourceUrl, checked_at: checkedAt },
      capabilities: { vision: { ...extraction.models[0].capabilities.vision, source_url: sourceUrl, checked_at: checkedAt } },
    }]);
    expect(result.models[0].capabilities.web_search).toBeUndefined();
    expect(result.features).toEqual([expect.objectContaining({ provider: "deepseek", feature: "web_search", source_url: sourceUrl })]);
  });

  it("rejects invented evidence, versions, IDs, unsupported keys, and duplicate IDs", () => {
    const invalid = [
      { models: [{ ...extraction.models[0], model_id: "invented-model" }] },
      { models: [{ ...extraction.models[0], version: { value: "Flash-9999", evidence: page } }] },
      { models: [{ model_id: "deepseek-flash", capabilities: { web_search: { value: true, evidence: "Invented support." } } }] },
      { models: [{ model_id: "deepseek-flash", capabilities: { telepathy: { value: true, evidence: page } } }] },
      { models: [extraction.models[0], extraction.models[0]] },
      { models: [], provider_features: [{ feature: "web_fetch", evidence: "Invented API." }] },
      { models: [{ model_id: "deepseek", version: { value: "Flash-1017", evidence: page } }] },
    ];
    for (const input of invalid) {
      expect(() => parseModelUpdates(JSON.stringify(input), page, "deepseek", sourceUrl, checkedAt)).toThrow();
    }
  });

  it("persists updates, reports new versions once, and keeps provider API adoption candidates visible", async () => {
    const first = await refreshModelUpdates();
    expect(first.sources).toHaveLength(MODEL_UPDATE_SOURCES.length);
    expect(first.sources.every((source) => source.ok)).toBe(true);
    expect(first.changed_models).toContainEqual(expect.objectContaining({ provider: "deepseek", model_id: "deepseek-flash", first_observed: true }));
    expect(first.changed_provider_features).toContainEqual(expect.objectContaining({ provider: "deepseek", feature: "web_search" }));
    expect(first.adoption_required).toContainEqual(expect.objectContaining({ provider: "deepseek", capability: "web_search" }));
    const second = await refreshModelUpdates();
    expect(second.changed_models).toEqual([]);
    expect(second.changed_provider_features).toEqual([]);
    expect(second.adoption_required.length).toBeGreaterThan(0);
    expect(resolvedModelMetadata("deepseek", "deepseek-flash").capabilities.web_search).toBe(false);
  });

  it("preserves absent and explicitly false capabilities across partial observations", () => {
    saveModelMetadata([{
      provider: "gemini", model_id: "gemini-example",
      capabilities: { vision: { value: false, evidence: "gemini-example does not support images.", source_url: "https://ai.google.dev/", checked_at: checkedAt } },
    }]);
    saveModelMetadata([{ provider: "gemini", model_id: "gemini-example", capabilities: {} }]);
    expect(resolvedModelMetadata("google-gemini", "gemini-example").capabilities.vision).toBe(false);
    expect(listModelMetadata("gemini")[0].capabilities.vision?.value).toBe(false);
    expect(resolvedModelMetadata(" GOOGLE-GEMINI ", "gemini-example").capabilities.json_mode).toBe(true);
  });

  it("reports rolling-version and explicit capability changes without treating absence as removal", async () => {
    await refreshModelUpdates();
    const updatedPage = "deepseek-flash now uses Flash-1025. deepseek-flash does not support image input.";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(updatedPage)));
    mocks.invoke.mockResolvedValue({ text: JSON.stringify({ models: [{
      model_id: "deepseek-flash",
      version: { value: "Flash-1025", evidence: "deepseek-flash now uses Flash-1025." },
      capabilities: { vision: { value: false, evidence: "deepseek-flash does not support image input." } },
    }] }) });
    const result = await refreshModelUpdates();
    expect(result.changed_models).toContainEqual(expect.objectContaining({
      provider: "deepseek", model_id: "deepseek-flash", first_observed: false, previous_version: "Flash-1017",
      version: expect.objectContaining({ value: "Flash-1025" }),
      changed_capabilities: { vision: expect.objectContaining({ previous: true, value: false }) },
    }));
    expect(result.changed_provider_features).toEqual([]);
    expect(result.adoption_required).toContainEqual(expect.objectContaining({ provider: "deepseek", capability: "web_search" }));
  });

  it("rejects conflicting same-run versions without rolling an alias back to an older changelog entry", async () => {
    const oldPage = "deepseek-flash now uses Flash-1001.";
    mocks.invoke.mockImplementation(async (_id, messages: Array<{ content: string }>) => ({
      text: JSON.stringify(messages[1].content.includes(oldPage)
        ? { models: [{ model_id: "deepseek-flash", version: { value: "Flash-1001", evidence: oldPage } }] }
        : extraction),
    }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(url.includes("/updates/") ? oldPage : page)));
    const result = await refreshModelUpdates();
    expect(result.sources.find((source) => source.url.includes("/updates/"))).toMatchObject({ ok: false, error: "Conflicting current versions: deepseek-flash" });
    expect(listModelMetadata("deepseek")[0].version?.value).toBe("Flash-1017");
  });

  it("follows same-origin redirects and discloses truncated model text", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/guides/search")
      ? new Response(null, { status: 301, headers: { location: "/guides/search/" } })
      : new Response(page + " x".repeat(13_000))));
    const result = await refreshModelUpdates();
    expect(result.sources.every((source) => source.ok && source.truncated)).toBe(true);
    expect(result.sources.find((source) => source.url.endsWith("/guides/search/"))).toBeDefined();
  });

  it("checks conflicts against every earlier page, including capabilities absent from the first", async () => {
    const positive = "deepseek-flash supports image input.";
    const negative = "deepseek-flash does not support image input.";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(
      url.endsWith("/updates/") ? positive : url.includes("/guides/search") ? negative : page,
    )));
    mocks.invoke.mockImplementation(async (_id, messages: Array<{ content: string }>) => {
      const content = messages[1].content;
      const models = content.includes("/updates/") || content.includes("/guides/search")
        ? [{ model_id: "deepseek-flash", capabilities: { vision: {
          value: !content.includes(negative), evidence: content.includes(negative) ? negative : positive,
        } } }]
        : [{ model_id: "deepseek-flash", version: extraction.models[0].version }];
      return { text: JSON.stringify({ models }) };
    });
    const result = await refreshModelUpdates();
    expect(result.sources.find((source) => source.url.includes("/guides/search"))).toMatchObject({
      ok: false, error: "Conflicting vision observations: deepseek-flash",
    });
    expect(listModelMetadata("deepseek")[0].capabilities.vision?.value).toBe(true);
  });

  it("retains previous metadata and reports every failed or invalid extraction", async () => {
    await refreshModelUpdates();
    const before = listModelMetadata();
    mocks.invoke.mockResolvedValue({ text: "not json" });
    const result = await refreshModelUpdates();
    expect(result.sources.every((source) => !source.ok && !!source.error)).toBe(true);
    expect(result.changed_models).toEqual([]);
    expect(listModelMetadata()).toEqual(before);
  });

  it("reports disabled extraction without fetching or invoking a model", async () => {
    mocks.config.pricingLlmExtract = false;
    const result = await refreshModelUpdates();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(result.sources.every((source) => !source.ok && source.error?.includes("disabled"))).toBe(true);
  });

  it("rejects redirects away from the official origin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://example.com/untrusted" } })));
    const result = await refreshModelUpdates();
    expect(result.sources.every((source) => !source.ok && source.error?.includes("origin"))).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("reports HTTP failures without clearing observations from successful sources", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://api-docs.deepseek.com/updates/") return new Response("unavailable", { status: 503 });
      return new Response(page);
    }));
    const result = await refreshModelUpdates();
    expect(result.sources.find((source) => source.url.endsWith("/updates/"))).toMatchObject({ ok: false, error: "HTTP 503" });
    expect(listModelMetadata("deepseek")[0].version?.value).toBe("Flash-1017");
  });
});
