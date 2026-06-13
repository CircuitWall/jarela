import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BridgeRouteRow } from "@/lib/stores/bridges";

const findRouteMock = vi.fn();
vi.mock("@/lib/stores/bridges", () => ({
  findRoute: (...args: unknown[]) => findRouteMock(...args),
}));

import { resolveRoute } from "./router";

beforeEach(() => {
  findRouteMock.mockReset();
});

const route = (over: Partial<BridgeRouteRow>): BridgeRouteRow => ({
  bridge_id: "b",
  remote_jid: "j",
  agent_id: "a",
  silent_mode: 0,
  ...over,
} as unknown as BridgeRouteRow);

describe("resolveRoute", () => {
  it("returns the exact route when one exists for (bridge, jid)", () => {
    const exact = route({ remote_jid: "55@c.us", agent_id: "alice" });
    findRouteMock.mockImplementation((_b: string, j: string) => (j === "55@c.us" ? exact : null));
    expect(resolveRoute("b", "55@c.us")).toBe(exact);
  });

  it("falls back to the bridge-level catch-all (remote_jid='*') when no exact match", () => {
    const star = route({ remote_jid: "*", agent_id: "triage" });
    findRouteMock.mockImplementation((_b: string, j: string) => (j === "*" ? star : null));
    expect(resolveRoute("b", "missing@c.us")).toBe(star);
  });

  it("returns null when neither exact nor catch-all match", () => {
    findRouteMock.mockReturnValue(null);
    expect(resolveRoute("b", "x")).toBeNull();
  });

  it("prefers exact over catch-all when both exist", () => {
    const exact = route({ remote_jid: "x", agent_id: "exact" });
    const star = route({ remote_jid: "*", agent_id: "fallback" });
    findRouteMock.mockImplementation((_b: string, j: string) => (j === "x" ? exact : j === "*" ? star : null));
    expect(resolveRoute("b", "x")?.agent_id).toBe("exact");
  });
});
