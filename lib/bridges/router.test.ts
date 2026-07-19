import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BridgeRouteRow } from "@/lib/stores/bridges";

const findRouteMock = vi.fn();
const isIgnoredMock = vi.fn();
vi.mock("@/lib/stores/bridges", () => ({
  findRoute: (...args: unknown[]) => findRouteMock(...args),
  isIgnored: (...args: unknown[]) => isIgnoredMock(...args),
}));

import { resolveRoute } from "./router";

beforeEach(() => {
  findRouteMock.mockReset();
  isIgnoredMock.mockReset();
  isIgnoredMock.mockReturnValue(false);
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

  it("returns null when the chat is on the bridge's ignore list, even with a matching exact route", () => {
    const exact = route({ remote_jid: "muted@c.us", agent_id: "listener" });
    findRouteMock.mockImplementation((_b: string, j: string) => (j === "muted@c.us" ? exact : null));
    isIgnoredMock.mockImplementation((_b: string, j: string) => j === "muted@c.us");
    expect(resolveRoute("b", "muted@c.us")).toBeNull();
    // Sanity: findRoute must not even be consulted for ignored chats.
    expect(findRouteMock).not.toHaveBeenCalled();
  });

  it("returns null when the chat is ignored and only a catch-all would otherwise match", () => {
    const star = route({ remote_jid: "*", agent_id: "triage" });
    findRouteMock.mockImplementation((_b: string, j: string) => (j === "*" ? star : null));
    isIgnoredMock.mockImplementation((_b: string, j: string) => j === "muted@c.us");
    expect(resolveRoute("b", "muted@c.us")).toBeNull();
  });
});
