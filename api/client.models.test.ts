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

describe("api.agents recent reply cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reuses the preload and refreshes after a thread update event", async () => {
    const replies = [{ agent_id: "agent-a", content: "Last reply" }];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(replies)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.agents.recentReplies()).resolves.toEqual(replies);
    await expect(api.agents.recentReplies()).resolves.toEqual(replies);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new CustomEvent("jarela:thread-updated", {
      detail: { thread_id: "thread-a", agent_id: "agent-a" },
    }));
    await expect(api.agents.recentReplies()).resolves.toEqual(replies);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("fetches live thread metadata without loading a message page", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ thread_id: "t1" }));
    vi.stubGlobal("fetch", fetchMock);

    await api.threads.metadata("t1");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/threads/t1?view=metadata");
    expect((fetchMock.mock.calls[0][1] as RequestInit).cache).toBe("no-store");
  });
});