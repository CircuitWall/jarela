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
let resolveEmbedClient = true;

vi.mock("@/lib/providers", () => ({
  getProvider: () => ({
    embed: (model: string, texts: string[], params: unknown) =>
      embedSpy(model, texts, params),
  }),
}));

vi.mock("@/lib/stores/model-config", () => ({
  getModelConfig: () => null,
  getDefaultModelConfig: () =>
    resolveEmbedClient
      ? { provider: "openai", model_id: "text-embedding-3-small", params: "{}" }
      : null,
}));

const { embedBestEffort } = await import("./index");

beforeEach(() => {
  embedSpy.mockReset();
  resolveEmbedClient = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("embedBestEffort", () => {
  it("returns one vector per input on success", async () => {
    embedSpy.mockResolvedValueOnce([[0.1], [0.2], [0.3]]);
    const r = await embedBestEffort(["a", "b", "c"]);
    expect(r.vectors).toEqual([[0.1], [0.2], [0.3]]);
    expect(r.error).toBeNull();
    expect(r.failed).toBe(0);
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
    expect(embedSpy).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-transient errors", async () => {
    embedSpy.mockRejectedValue(new Error("HTTP 401 Unauthorized"));
    const r = await embedBestEffort(["only one"]);
    expect(r.vectors).toEqual([null]);
    expect(r.failed).toBe(1);
    expect(r.error).toContain("401");
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
  });

  it("pads short responses with nulls to keep indices aligned", async () => {
    embedSpy.mockResolvedValueOnce([[1]]); // only 1 of 2 vectors returned
    const r = await embedBestEffort(["a", "b"]);
    expect(r.vectors).toEqual([[1], null]);
    expect(r.failed).toBe(1);
    expect(r.error).toContain("1/2");
  });

  it("returns no-provider error when client cannot be resolved", async () => {
    resolveEmbedClient = false;
    const r = await embedBestEffort(["a", "b"]);
    expect(r.vectors).toEqual([null, null]);
    expect(r.failed).toBe(2);
    expect(r.error).toBe("no embedding provider configured");
    expect(embedSpy).not.toHaveBeenCalled();
  });
});
