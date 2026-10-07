import { beforeEach, describe, expect, it, vi } from "vitest";
import { join, sep } from "node:path";
import { LOCAL_EMBEDDING_DIMENSIONS, LOCAL_EMBEDDING_MODEL_ID } from "./constants";

const mocks = vi.hoisted(() => {
  const tokenizer = Object.assign(vi.fn(), { decode: vi.fn() });
  const extractor = Object.assign(vi.fn(), { tokenizer });
  return { env: {} as Record<string, unknown>, pipeline: vi.fn(), tokenizer, extractor };
});

vi.mock("@huggingface/transformers", () => ({ env: mocks.env, pipeline: mocks.pipeline }));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: vi.fn(() => true),
}));

const { embedLocally, splitIntoTokenWindows } = await import("./local");
const modelPath = join(process.cwd(), ".jarela-assets", "local-embedding");

beforeEach(() => {
  const globals = globalThis as typeof globalThis & { __jarelaLocalEmbeddingPipeline?: Promise<unknown> };
  globals.__jarelaLocalEmbeddingPipeline = undefined;
  mocks.env.allowRemoteModels = true;
  mocks.pipeline.mockReset().mockResolvedValue(mocks.extractor);
  mocks.tokenizer.mockReset().mockImplementation(() => ({
    input_ids: { tolist: () => [Array.from({ length: 600 }, (_, index) => index + 1)] },
  }));
  mocks.tokenizer.decode.mockReset().mockImplementation((ids: number[]) => `window-${ids.length}`);
  mocks.extractor.mockReset().mockImplementation(async (texts: string[]) => ({
    tolist: () => texts.map(() => new Array(LOCAL_EMBEDDING_DIMENSIONS).fill(1)),
  }));
});

describe("local embedding model", () => {
  it("splits long token sequences into overlapping bounded windows", () => {
    const windows = splitIntoTokenWindows(Array.from({ length: 600 }, (_, index) => index));
    expect(windows.map((window) => window.length)).toEqual([500, 132]);
    expect(windows[0].slice(-32)).toEqual(windows[1].slice(0, 32));
    expect(windows.flat().length).toBeGreaterThan(600);
  });

  it("loads local-only q8 inference and aggregates all windows to one normalized vector per input", async () => {
    const vectors = await embedLocally(["long text", "another long text"], "passage");

    expect(mocks.pipeline).toHaveBeenCalledWith("feature-extraction", LOCAL_EMBEDDING_MODEL_ID, { dtype: "q8" });
    expect(mocks.env.allowRemoteModels).toBe(false);
    expect(mocks.env.allowLocalModels).toBe(true);
    expect(mocks.env.localModelPath).toBe(`${modelPath}${sep}`);
    expect(mocks.tokenizer).toHaveBeenCalledTimes(2);
    expect(mocks.extractor).toHaveBeenCalledTimes(1);
    expect(mocks.extractor.mock.calls[0][0]).toEqual([
      "passage: window-500",
      "passage: window-132",
      "passage: window-500",
      "passage: window-132",
    ]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(LOCAL_EMBEDDING_DIMENSIONS);
    expect(Math.sqrt(vectors[0].reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 6);
  });

  it("uses the query prefix for retrieval text", async () => {
    await embedLocally(["recherche documentaire"], "query");

    expect(mocks.extractor.mock.calls[0][0]).toEqual([
      "query: window-500",
      "query: window-132",
    ]);
  });
});
