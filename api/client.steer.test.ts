// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./runtime-config", () => ({
  runtimeConfig: () => ({ httpMaxAttempts: 2, httpRequestTimeoutMs: 30_000 }),
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("chat steering client", () => {
  it("retries with the same request id and acknowledges an already-accepted steer", async () => {
    const { api } = await import("./client");
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ error: "temporary" }, 503))
      .mockResolvedValueOnce(json({ steered: true, duplicate: true }));
    vi.stubGlobal("fetch", fetch);

    await expect(api.threads.steerRun(
      "thread", "Focus on the API.", "00000000-0000-4000-8000-000000000001",
    )).resolves.toEqual({ steered: true, duplicate: true });

    expect(fetch).toHaveBeenCalledTimes(2);
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      { message: "Focus on the API.", request_id: "00000000-0000-4000-8000-000000000001" },
      { message: "Focus on the API.", request_id: "00000000-0000-4000-8000-000000000001" },
    ]);
  });

  it("treats a no-active-run conflict as the normal fallback", async () => {
    const { api } = await import("./client");
    const fetch = vi.fn().mockResolvedValue(
      json({ steered: false, reason: "no_active_run" }, 409),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(api.threads.steerRun(
      "thread", "Focus on the API.", "00000000-0000-4000-8000-000000000001",
    )).resolves.toEqual({ steered: false, reason: "no_active_run" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("surfaces an idempotency-key conflict instead of treating it as inactive", async () => {
    const { api } = await import("./client");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      json({ steered: false, reason: "request_id_conflict" }, 409),
    ));

    await expect(api.threads.steerRun(
      "thread", "Focus on the API.", "00000000-0000-4000-8000-000000000001",
    )).rejects.toThrow("request_id_conflict");
  });
});
