// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "./types";
import { api } from "./client";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function model(modelId: string): ModelConfig {
  return {
    name: "race-model",
    provider: "mock",
    model_id: modelId,
    params: {},
    is_default: false,
    enabled: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("api.models list cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not let a list started before a mutation replace the newer snapshot", async () => {
    let resolveOldList!: (response: Response) => void;
    const oldListResponse = new Promise<Response>((resolve) => { resolveOldList = resolve; });
    const updated = model("new-model");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockReturnValueOnce(oldListResponse)
      .mockResolvedValueOnce(jsonResponse(updated))
      .mockResolvedValueOnce(jsonResponse([updated]));
    vi.stubGlobal("fetch", fetchMock);

    const oldList = api.models.list({ force: true });
    await api.models.update("race-model", { provider: "mock", model_id: "new-model" });
    const latestList = api.models.list();

    resolveOldList(jsonResponse([model("old-model")]));
    await expect(Promise.all([oldList, latestList])).resolves.toEqual([[updated], [updated]]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("api request HTTP cache mode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bypasses the browser HTTP cache for mutable lists so reads after writes are fresh", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([])));
    vi.stubGlobal("fetch", fetchMock);

    await api.models.list({ force: true });
    await api.agents.list({ force: true });
    await api.tasks.list({ force: true });
    await api.credentials.list();

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).cache).toBe("no-store");
    }
  });

  it("lets read-only dashboard metrics keep the server's HTTP cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await api.dashboard.metrics(7);

    expect((fetchMock.mock.calls[0][1] as RequestInit).cache).toBe("default");
  });
});