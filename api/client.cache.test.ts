// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { api as Api } from "./client";
import type { ModelConfig } from "./types";

vi.mock("./runtime-config", () => ({
  runtimeConfig: () => ({ httpMaxAttempts: 1, httpRequestTimeoutMs: 30_000 }),
}));

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

function model(id: string): ModelConfig {
  return {
    name: "synthetic", provider: "mock", model_id: id, params: {},
    is_default: false, enabled: true,
    created_at: "2026-10-31T00:00:00Z", updated_at: "2026-10-31T00:00:00Z",
  };
}

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function cacheCase(api: typeof Api, kind: "list" | "value") {
  return kind === "list"
    ? {
      read: () => api.models.list(),
      invalidate: () => api.models.patch("synthetic", { enabled: true }),
      payload: (id: string) => [model(id)],
    }
    : {
      read: () => api.integrations.list(),
      invalidate: () => api.integrations.save("synthetic", {}),
      payload: (id: string) => ({ definitions: [], statuses: { id } }),
    };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(["list", "value"] as const)("%s client cache lifecycle", (kind) => {
  it("shares pending requests and expires precisely at the 30-second boundary", async () => {
    const { api } = await import("./client");
    const cache = cacheCase(api, kind);
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const pending = deferred();
    const fetch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(json(cache.payload("new")));
    vi.stubGlobal("fetch", fetch);
    const first = cache.read();
    expect(cache.read()).toBe(first);
    pending.resolve(json(cache.payload("old")));
    await expect(first).resolves.toEqual(cache.payload("old"));
    now += 29_999;
    await expect(cache.read()).resolves.toEqual(cache.payload("old"));
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 1;
    await expect(cache.read()).resolves.toEqual(cache.payload("new"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("clears rejected reads so the next read can recover", async () => {
    const { api } = await import("./client");
    const cache = cacheCase(api, kind);
    const fetch = vi.fn().mockResolvedValueOnce(new Response("locked", { status: 423 }))
      .mockResolvedValueOnce(json(cache.payload("recovered")));
    vi.stubGlobal("fetch", fetch);
    await expect(cache.read()).rejects.toThrow("423");
    await expect(cache.read()).resolves.toEqual(cache.payload("recovered"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refetches when an invalidated read completes without a newer snapshot", async () => {
    const { api } = await import("./client");
    const cache = cacheCase(api, kind);
    const old = deferred();
    const fetch = vi.fn().mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(json(model("write")))
      .mockResolvedValueOnce(json(cache.payload("new")));
    vi.stubGlobal("fetch", fetch);
    const first = cache.read();
    await cache.invalidate();
    old.resolve(json(cache.payload("old")));
    await expect(first).resolves.toEqual(cache.payload("new"));
    await expect(cache.read()).resolves.toEqual(cache.payload("new"));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("joins the newer pending read instead of restoring obsolete data", async () => {
    const { api } = await import("./client");
    const cache = cacheCase(api, kind);
    const old = deferred();
    const latest = deferred();
    const fetch = vi.fn().mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(json(model("write"))).mockReturnValueOnce(latest.promise);
    vi.stubGlobal("fetch", fetch);
    const first = cache.read();
    await cache.invalidate();
    const second = cache.read();
    old.resolve(json(cache.payload("old")));
    latest.resolve(json(cache.payload("new")));
    await expect(Promise.all([first, second])).resolves.toEqual([cache.payload("new"), cache.payload("new")]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not clear a newer request when an obsolete read fails", async () => {
    const { api } = await import("./client");
    const cache = cacheCase(api, kind);
    const old = deferred();
    const latest = deferred();
    const fetch = vi.fn().mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(json(model("write"))).mockReturnValueOnce(latest.promise);
    vi.stubGlobal("fetch", fetch);
    const first = cache.read();
    const failure = expect(first).rejects.toThrow("400");
    await cache.invalidate();
    const second = cache.read();
    old.resolve(new Response("obsolete failure", { status: 400 }));
    await failure;
    expect(cache.read()).toBe(second);
    latest.resolve(json(cache.payload("new")));
    await expect(second).resolves.toEqual(cache.payload("new"));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps the newer completed snapshot when an obsolete read finishes", async () => {
    const { api } = await import("./client");
    const cache = cacheCase(api, kind);
    const old = deferred();
    const fetch = vi.fn().mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(json(model("write"))).mockResolvedValueOnce(json(cache.payload("new")));
    vi.stubGlobal("fetch", fetch);
    const first = cache.read();
    await cache.invalidate();
    await cache.read();
    old.resolve(json(cache.payload("old")));
    await expect(first).resolves.toEqual(cache.payload("new"));
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("client cache shape-specific behavior", () => {
  it("copies list rows without sharing the cached top-level objects", async () => {
    const { api } = await import("./client");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([model("old")])));
    const first = await api.models.list();
    first[0].model_id = "modified";
    first.length = 0;
    const second = await api.models.list();
    expect(second).toEqual([model("old")]);
    expect(second).not.toBe(first);
  });

  it("retains value identity on cache hits", async () => {
    const { api } = await import("./client");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ definitions: [], statuses: {} })));
    const first = await api.integrations.list();
    expect(await api.integrations.list()).toBe(first);
  });

  it("forces a new list request and makes the old read follow it", async () => {
    const { api } = await import("./client");
    const old = deferred();
    const latest = deferred();
    const fetch = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    vi.stubGlobal("fetch", fetch);
    const first = api.models.list();
    const second = api.models.list({ force: true });
    expect(second).not.toBe(first);
    old.resolve(json([model("old")]));
    latest.resolve(json([model("new")]));
    await expect(Promise.all([first, second])).resolves.toEqual([[model("new")], [model("new")]]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not notify subscribers on list reads, but preserves mutation notifications", async () => {
    const { api } = await import("./client");
    const changed = vi.fn();
    window.addEventListener("jarela:models-changed", changed);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json([model("old")]))
      .mockResolvedValueOnce(json(model("new"))));
    try {
      await api.models.list();
      expect(changed).not.toHaveBeenCalled();
      await api.models.update("synthetic", { provider: "mock", model_id: "new" });
      expect(changed).toHaveBeenCalled();
      await expect(api.models.list()).resolves.toEqual([model("new")]);
    } finally {
      window.removeEventListener("jarela:models-changed", changed);
    }
  });
});
