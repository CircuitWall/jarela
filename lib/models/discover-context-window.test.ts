import { describe, it, expect, vi, beforeEach } from "vitest";

const listModelsMock = vi.fn<(p: unknown) => Promise<Array<{ id: string; context_length: number | null; max_output_tokens: number | null; hosted_on: string | null; capabilities: Record<string, boolean> }>>>();

vi.mock("@/lib/providers", () => ({
  getProvider: (name: string) => {
    if (name === "no-list") return { /* no listModels */ };
    if (name === "throws") return { listModels: async () => { throw new Error("boom"); } };
    if (name === "mocked") return { listModels: listModelsMock };
    throw new Error(`unknown provider ${name}`);
  },
}));

vi.mock("@/lib/providers/known-context-windows", () => ({
  getKnownContextLength: (provider: string, model_id: string): number | null => {
    if (provider === "anthropic" && model_id === "claude-3-5-sonnet") return 200_000;
    return null;
  },
}));

const { discoverContextWindow, enrichParamsWithDiscoveredContext } =
  await import("./discover-context-window");

beforeEach(() => {
  listModelsMock.mockReset();
});

describe("discoverContextWindow", () => {
  it("returns the catalog value on an exact match", async () => {
    listModelsMock.mockResolvedValueOnce([
      { id: "gemini-2.5-flash", context_length: 1_048_576, max_output_tokens: 65536, hosted_on: "google", capabilities: {} },
    ]);
    const n = await discoverContextWindow("mocked", "gemini-2.5-flash", {});
    expect(n).toBe(1_048_576);
  });

  it("prefix-matches when the catalog uses a versioned id", async () => {
    listModelsMock.mockResolvedValueOnce([
      { id: "gpt-4o-2024-08-06", context_length: 128_000, max_output_tokens: 16384, hosted_on: "openai", capabilities: {} },
    ]);
    const n = await discoverContextWindow("mocked", "gpt-4o", {});
    expect(n).toBe(128_000);
  });

  it("falls through to the static table when the catalog is silent", async () => {
    // known-context-windows has claude-3-5-sonnet; provider "no-list" has no
    // listModels so we go straight to the static lookup.
    const n = await discoverContextWindow("no-list", "claude-3-5-sonnet", {});
    expect(n).toBe(null); // provider name doesn't match static-table dispatch
    // but the anthropic-provider path DOES dispatch through the static table:
    const n2 = await discoverContextWindow("anthropic", "claude-3-5-sonnet", {});
    expect(n2).toBe(200_000);
  });

  it("returns null when both dynamic and static lookups miss", async () => {
    listModelsMock.mockResolvedValueOnce([]);
    const n = await discoverContextWindow("mocked", "brand-new-model-x", {});
    expect(n).toBe(null);
  });

  it("swallows listModels errors and falls back to the static table", async () => {
    // "throws" provider raises; helper must not throw. There's no static
    // entry for an unknown provider name, so it returns null.
    const n = await discoverContextWindow("throws", "claude-3-5-sonnet", {});
    expect(n).toBe(null);
  });
});

describe("enrichParamsWithDiscoveredContext", () => {
  it("does not overwrite an explicit user value", async () => {
    listModelsMock.mockResolvedValueOnce([
      { id: "x", context_length: 1_000_000, max_output_tokens: 1000, hosted_on: null, capabilities: {} },
    ]);
    const params = { context_window_tokens: 32_000, api_key: "sk-x" };
    const out = await enrichParamsWithDiscoveredContext("mocked", "x", params);
    expect(out).toBe(params);
    expect(out.context_window_tokens).toBe(32_000);
    // listModels should not have been called at all when the caller pinned it.
    expect(listModelsMock).not.toHaveBeenCalled();
  });

  it("merges a discovered value when the user left it unset", async () => {
    listModelsMock.mockResolvedValueOnce([
      { id: "x", context_length: 200_000, max_output_tokens: 8192, hosted_on: null, capabilities: {} },
    ]);
    const params = { api_key: "sk-x" };
    const out = await enrichParamsWithDiscoveredContext("mocked", "x", params);
    expect(out).not.toBe(params);
    expect(out.context_window_tokens).toBe(200_000);
    expect(out.api_key).toBe("sk-x");
  });

  it("leaves params unchanged when discovery returns null", async () => {
    listModelsMock.mockResolvedValueOnce([]);
    const params = { api_key: "sk-x" };
    const out = await enrichParamsWithDiscoveredContext("mocked", "no-such", params);
    expect(out).toBe(params);
    expect("context_window_tokens" in out).toBe(false);
  });
});
