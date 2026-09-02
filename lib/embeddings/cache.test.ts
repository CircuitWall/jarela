import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-embed-cache-"));
process.env.JARELA_DB_DIR = tmpRoot;
process.on("exit", () => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const embedSpy = vi.fn();

vi.mock("@/lib/providers", () => ({
  getProvider: () => ({
    embed: (model: string, texts: string[], params: unknown) => embedSpy(model, texts, params),
  }),
}));

vi.mock("@/lib/stores/model-config", () => ({
  getModelConfig: () => null,
  getDefaultModelConfig: () => ({ provider: "openai", model_id: "text-embedding-3-small", params: "{}" }),
  listModelConfigs: () => [],
  getModelParams: () => ({}),
}));

vi.mock("@/lib/stores/app-settings", () => ({ getEmbeddingModelConfigName: () => null }));

const { embed, embedOne, _resetEmbeddingCache } = await import("./index");

// A vector per distinct text, so a wrong mapping is visible rather than silent.
function vectorFor(text: string): number[] {
  return [text.length, text.charCodeAt(0) || 0];
}

describe("embedding cache", () => {
  beforeEach(() => {
    _resetEmbeddingCache();
    embedSpy.mockReset();
    embedSpy.mockImplementation((_model: string, texts: string[]) => texts.map(vectorFor));
  });

  it("calls the provider once for a repeated text", async () => {
    const first = await embedOne("stable baseline");
    const second = await embedOne("stable baseline");

    expect(second).toEqual(first);
    expect(embedSpy).toHaveBeenCalledTimes(1);
  });

  it("sends only the uncached texts on a partial hit", async () => {
    await embed(["alpha", "beta"]);
    embedSpy.mockClear();

    const out = await embed(["alpha", "gamma", "beta"]);

    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(embedSpy.mock.calls[0][1]).toEqual(["gamma"]);
    // Order must follow the request, not the order vectors came back in.
    expect(out).toEqual([vectorFor("alpha"), vectorFor("gamma"), vectorFor("beta")]);
  });

  it("collapses duplicates inside a single batch", async () => {
    const out = await embed(["dup", "dup", "other"]);

    expect(embedSpy.mock.calls[0][1]).toEqual(["dup", "other"]);
    expect(out).toEqual([vectorFor("dup"), vectorFor("dup"), vectorFor("other")]);
  });

  it("skips the provider entirely when every text is cached", async () => {
    await embed(["one", "two"]);
    embedSpy.mockClear();

    const out = await embed(["two", "one"]);

    expect(embedSpy).not.toHaveBeenCalled();
    expect(out).toEqual([vectorFor("two"), vectorFor("one")]);
  });

  it("does not cache a failed call", async () => {
    embedSpy.mockImplementationOnce(() => { throw new Error("boom"); });

    expect(await embed(["retry me"])).toBeNull();

    expect(await embed(["retry me"])).toEqual([vectorFor("retry me")]);
    expect(embedSpy).toHaveBeenCalledTimes(2);
  });
});
