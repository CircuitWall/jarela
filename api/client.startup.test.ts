// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./runtime-config", () => ({
  runtimeConfig: () => ({ httpMaxAttempts: 1, httpRequestTimeoutMs: 30_000 }),
}));

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

describe("agent startup handoff", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shares all four startup reads between boot and chat without sharing mutable objects", async () => {
    const { api } = await import("./client");
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(json({ nested: { value: "original" } })));
    vi.stubGlobal("fetch", fetch);
    const load = () => Promise.all([
      api.profile.get({ startup: true }),
      api.agents.get("agent", { startup: true }),
      api.agents.getThread("agent", { startup: true }),
      api.threads.get("thread", { startup: true }),
    ]);
    const [boot, chat] = await Promise.all([load(), load()]);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(chat).toEqual(boot);
    expect(chat[0]).not.toBe(boot[0]);
    await load();
    expect(fetch).toHaveBeenCalledTimes(4);
    for (const [, init] of fetch.mock.calls) {
      expect(init.cache).toBe("no-store");
      expect(init).not.toHaveProperty("startup");
    }
  });

  it("expires startup reads after five seconds and keeps ordinary reads fresh", async () => {
    const { api } = await import("./client");
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(json({ name: "profile" })));
    vi.stubGlobal("fetch", fetch);
    await api.profile.get({ startup: true });
    now += 4_999;
    await api.profile.get({ startup: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 1;
    await api.profile.get({ startup: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    await api.profile.get();
    await api.profile.get({ startup: true });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("isolates nested transcript data between consumers", async () => {
    const { api } = await import("./client");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ messages: [{ id: "message" }] })));
    const first = await api.threads.get("thread", { startup: true });
    first.messages.length = 0;
    const second = await api.threads.get("thread", { startup: true });
    expect(second.messages).toEqual([{ id: "message" }]);
  });

  it("invalidates pending warmups before writes and never caches failed reads", async () => {
    const { api } = await import("./client");
    let resolveOld!: (response: Response) => void;
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(json({ name: "updated" }))
      .mockResolvedValueOnce(json({ name: "updated" }))
      .mockResolvedValueOnce(new Response("failed", { status: 400 }))
      .mockResolvedValueOnce(json({ name: "recovered" }));
    vi.stubGlobal("fetch", fetch);
    const old = api.profile.get({ startup: true });
    await api.profile.update({ name: "updated" });
    resolveOld(json({ name: "old" }));
    await old;
    expect(await api.profile.get({ startup: true })).toEqual({ name: "updated" });
    await expect(api.agents.get("retry", { startup: true })).rejects.toThrow("400");
    await expect(api.agents.get("retry", { startup: true })).resolves.toEqual({ name: "recovered" });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("clears the startup page before submitting a run", async () => {
    const { api, submitRun } = await import("./client");
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ messages: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(json({ messages: [{ id: "new" }] }));
    vi.stubGlobal("fetch", fetch);
    await api.threads.get("thread", { startup: true });
    await submitRun("thread", "hello", new AbortController().signal);
    await expect(api.threads.get("thread", { startup: true })).resolves.toEqual({ messages: [{ id: "new" }] });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("discards startup data read while a write was still in flight", async () => {
    const { api } = await import("./client");
    let finishWrite!: (response: Response) => void;
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishWrite = resolve; }))
      .mockResolvedValueOnce(json({ name: "old" }))
      .mockResolvedValueOnce(json({ name: "new" }));
    vi.stubGlobal("fetch", fetch);
    const write = api.profile.update({ name: "new" });
    await expect(api.profile.get({ startup: true })).resolves.toEqual({ name: "old" });
    finishWrite(json({ name: "new" }));
    await write;
    await expect(api.profile.get({ startup: true })).resolves.toEqual({ name: "new" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("bounds retained data and separates thread cursor requests", async () => {
    const { api } = await import("./client");
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(json({ messages: [] })));
    vi.stubGlobal("fetch", fetch);
    for (let i = 0; i < 17; i++) await api.threads.get(`thread-${i}`, { startup: true });
    await api.threads.get("thread-0", { startup: true });
    expect(fetch).toHaveBeenCalledTimes(18);
    await api.threads.get("thread-0", { after: 10 });
    expect(fetch.mock.calls[18][0]).toBe("/api/v1/threads/thread-0?after=10");
  });
});
