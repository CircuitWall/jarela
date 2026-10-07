import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated SQLite per test process; embeddings module reads model_configs
// via getDefaultModelConfig (mocked below), but importing it still opens
// the DB on first use, so it needs to point at a writable tmp dir.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-embed-"));
process.env.JARELA_DB_DIR = tmpRoot;
process.on("exit", () => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const embedSpy = vi.fn();
const localEmbedSpy = vi.fn();
let resolveEmbedClient = true;

vi.mock("@/lib/providers", () => ({
  getProvider: () => ({
    embed: (model: string, texts: string[], params: unknown) =>
      embedSpy(model, texts, params),
  }),
}));

vi.mock("./local", () => ({
  embedLocally: (texts: string[]) => localEmbedSpy(texts),
}));

vi.mock("@/lib/stores/model-config", () => ({
  getModelConfig: () => null,
  getDefaultModelConfig: () =>
    resolveEmbedClient
      ? { provider: "openai", model_id: "text-embedding-3-small", params: "{}" }
      : null,
  // resolveEmbeddingClient falls back to scanning all configured models when
  // the default can't embed. These tests mock the default directly, so an
  // empty list is the right shape — no fallback row should ever match.
  listModelConfigs: () => [],
  // The real getModelParams parses cfg.params as JSON; tests pass `"{}"` so
  // returning {} matches the production shape.
  getModelParams: () => ({}),
}));

const { embed, embedDocument, embedBestEffort, embedOne } = await import("./index");
const { setDocumentLocalEmbeddings } = await import("@/lib/stores/app-settings");
const originalEmbeddingModelConfig = process.env.EMBEDDING_MODEL_CONFIG;

beforeEach(() => {
  embedSpy.mockReset();
  localEmbedSpy.mockReset();
  resolveEmbedClient = true;
  delete process.env.EMBEDDING_MODEL_CONFIG;
  setDocumentLocalEmbeddings(false);
});

afterEach(() => {
  vi.useRealTimers();
  if (originalEmbeddingModelConfig === undefined) delete process.env.EMBEDDING_MODEL_CONFIG;
  else process.env.EMBEDDING_MODEL_CONFIG = originalEmbeddingModelConfig;
});

describe("embedBestEffort", () => {
  it("returns one vector per input on success", async () => {
    embedSpy.mockResolvedValueOnce([[0.1], [0.2], [0.3]]);
    const r = await embedBestEffort(["a", "b", "c"]);
    expect(r.vectors).toEqual([[0.1], [0.2], [0.3]]);
    expect(r.error).toBeNull();
    expect(r.failed).toBe(0);
    expect(r.terminal).toEqual([false, false, false]);
    expect(embedSpy).toHaveBeenCalledTimes(1);
  });

  it("retries on transient errors then succeeds", async () => {
    vi.useFakeTimers();
    embedSpy
      .mockRejectedValueOnce(new Error("HTTP 429 Too Many Requests"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce([[1], [2]]);
    const p = embedBestEffort(["x", "y"]);
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.vectors).toEqual([[1], [2]]);
    expect(r.failed).toBe(0);
    expect(r.terminal).toEqual([false, false]);
    expect(embedSpy).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-transient errors, and marks the failure terminal", async () => {
    embedSpy.mockRejectedValue(new Error("HTTP 401 Unauthorized"));
    const r = await embedBestEffort(["only one"]);
    expect(r.vectors).toEqual([null]);
    expect(r.failed).toBe(1);
    expect(r.error).toContain("401");
    expect(r.terminal).toEqual([true]);
    expect(embedSpy).toHaveBeenCalledTimes(1);
  });

  it("halves the batch on persistent failure so good inputs survive", async () => {
    embedSpy
      // whole batch of 4 fails:
      .mockRejectedValueOnce(new Error("HTTP 400 batch too large"))
      // left half of 2 fails:
      .mockRejectedValueOnce(new Error("HTTP 400 batch too large"))
      // left-left singleton ok:
      .mockResolvedValueOnce([[10]])
      // left-right singleton fails permanently:
      .mockRejectedValueOnce(new Error("HTTP 400 bad input"))
      // right half of 2 ok:
      .mockResolvedValueOnce([[30], [40]]);

    const r = await embedBestEffort(["a", "b", "c", "d"]);
    expect(r.vectors).toEqual([[10], null, [30], [40]]);
    expect(r.failed).toBe(1);
    expect(r.error).toContain("400");
    // Only the singleton that hit a genuinely bad-input error is terminal;
    // the 400s on the larger batches were "some input in here is bad" and
    // got resolved by bisection, not attributable to a specific index.
    expect(r.terminal).toEqual([false, true, false, false]);
  });

  it("pads short responses with nulls to keep indices aligned, without marking terminal", async () => {
    embedSpy.mockResolvedValueOnce([[1]]); // only 1 of 2 vectors returned
    const r = await embedBestEffort(["a", "b"]);
    expect(r.vectors).toEqual([[1], null]);
    expect(r.failed).toBe(1);
    expect(r.error).toContain("1/2");
    expect(r.terminal).toEqual([false, false]);
  });

  it("returns no-provider error when client cannot be resolved, without marking terminal", async () => {
    resolveEmbedClient = false;
    const r = await embedBestEffort(["a", "b"]);
    expect(r.vectors).toEqual([null, null]);
    expect(r.failed).toBe(2);
    expect(r.error).toBe("no embedding provider configured");
    expect(r.terminal).toEqual([false, false]);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("uses the bundled model only for document indexing/search, not message or memory embeddings", async () => {
    setDocumentLocalEmbeddings(true);
    localEmbedSpy.mockResolvedValue([[0.25, 0.75]]);
    embedSpy.mockResolvedValue([[0.9, 0.1]]);

    const indexed = await embedBestEffort(["local document chunk"]);
    const query = await embedDocument(["local search query"]);
    const memory = await embed(["memory and conversation embedding"]);
    const message = await embedOne("message embedding");

    expect(indexed.vectors).toEqual([[0.25, 0.75]]);
    expect(indexed.failed).toBe(0);
    expect(query).toEqual([[0.25, 0.75]]);
    expect(memory).toEqual([[0.9, 0.1]]);
    expect(message).toEqual([0.9, 0.1]);
    expect(localEmbedSpy).toHaveBeenNthCalledWith(1, ["local document chunk"]);
    expect(localEmbedSpy).toHaveBeenNthCalledWith(2, ["local search query"]);
    expect(embedSpy).toHaveBeenCalledTimes(2);
  });
});
