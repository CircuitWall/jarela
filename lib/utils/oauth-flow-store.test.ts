import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createOAuthFlowStore } from "./oauth-flow-store";

const KEY = "__test_oauth_flow_store";

beforeEach(() => {
  delete (globalThis as unknown as Record<string, unknown>)[KEY];
});
afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>)[KEY];
  vi.useRealTimers();
});

const makeInput = () => ({
  clientId: "cid",
  clientSecret: "secret",
  redirectUri: "https://example.com/cb",
});

describe("createOAuthFlowStore", () => {
  it("creates a flow with a random hex state and pending status", () => {
    const store = createOAuthFlowStore({ globalKey: KEY });
    const { state, flow } = store.create(makeInput());
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(flow.status).toBe("pending");
    expect(flow.clientId).toBe("cid");
    expect(flow.clientSecret).toBe("secret");
  });

  it("returns the flow via get(state)", () => {
    const store = createOAuthFlowStore({ globalKey: KEY });
    const { state } = store.create(makeInput());
    expect(store.get(state)?.clientId).toBe("cid");
  });

  it("updates fields via update(state, patch)", () => {
    const store = createOAuthFlowStore({ globalKey: KEY });
    const { state } = store.create(makeInput());
    store.update(state, { status: "done" });
    expect(store.get(state)?.status).toBe("done");
  });

  it("update with unknown state is a no-op", () => {
    const store = createOAuthFlowStore({ globalKey: KEY });
    expect(() => store.update("nope", { status: "done" })).not.toThrow();
    expect(store.get("nope")).toBeUndefined();
  });

  it("delete(state) removes the flow", () => {
    const store = createOAuthFlowStore({ globalKey: KEY });
    const { state } = store.create(makeInput());
    store.delete(state);
    expect(store.get(state)).toBeUndefined();
  });

  it("expires entries past the TTL", () => {
    vi.useFakeTimers();
    const start = new Date("2026-05-21T00:00:00Z").getTime();
    vi.setSystemTime(start);

    const store = createOAuthFlowStore({ globalKey: KEY, ttlMs: 1000 });
    const { state } = store.create(makeInput());
    expect(store.get(state)).toBeDefined();

    vi.setSystemTime(start + 2000);
    expect(store.get(state)).toBeUndefined();
  });

  it("hard-caps the size by evicting oldest entries", () => {
    vi.useFakeTimers();
    const start = new Date("2026-05-21T00:00:00Z").getTime();
    vi.setSystemTime(start);

    const store = createOAuthFlowStore({ globalKey: KEY, maxFlows: 2 });
    const { state: s1 } = store.create(makeInput());
    vi.setSystemTime(start + 1);
    const { state: s2 } = store.create(makeInput());
    vi.setSystemTime(start + 2);
    const { state: s3 } = store.create(makeInput());
    // Trigger gc (cap is enforced on next access).
    store.get(s3);

    expect(store.get(s1)).toBeUndefined();
    expect(store.get(s2)).toBeDefined();
    expect(store.get(s3)).toBeDefined();
  });

  it("scopes by globalKey — separate stores don't share", () => {
    const a = createOAuthFlowStore({ globalKey: "__test_oauth_a" });
    const b = createOAuthFlowStore({ globalKey: "__test_oauth_b" });
    const { state } = a.create(makeInput());
    expect(b.get(state)).toBeUndefined();
    delete (globalThis as unknown as Record<string, unknown>).__test_oauth_a;
    delete (globalThis as unknown as Record<string, unknown>).__test_oauth_b;
  });
});
