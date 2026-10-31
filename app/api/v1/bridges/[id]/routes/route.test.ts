import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { BridgeRouteRow } from "@/lib/stores/bridges";

const store = vi.hoisted(() => ({
  getBridge: vi.fn(), listRoutes: vi.fn(), createRoute: vi.fn(), getRoute: vi.fn(), updateRoute: vi.fn(),
}));

vi.mock("@/lib/stores/bridges", () => store);
vi.mock("@/lib/stores/agent-configs", () => ({ getAgentConfig: vi.fn(() => ({ id: "agent" })) }));

import { GET, POST } from "./route";
import { PATCH } from "./[route_id]/route";

const row: BridgeRouteRow = {
  id: "route", bridge_id: "bridge", remote_jid: "*", agent_id: "agent",
  label: null, silent_mode: 1, respond_to: "counterpart", last_seen_ts: 123,
  created_at: "2026-10-31T00:00:00Z", updated_at: "2026-10-31T01:00:00Z",
};
const expected = {
  id: row.id, bridge_id: row.bridge_id, remote_jid: row.remote_jid, agent_id: row.agent_id,
  label: null, silent_mode: true, respond_to: "counterpart",
  created_at: row.created_at, updated_at: row.updated_at,
};
const context = () => ({ params: Promise.resolve({ id: "bridge", route_id: "route" }) });
const request = (method: string, body: unknown) => new NextRequest("http://localhost/api/v1/bridges/bridge/routes", {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  store.getBridge.mockReturnValue({ id: "bridge" });
  store.listRoutes.mockReturnValue([row]);
  store.createRoute.mockReturnValue(row);
  store.getRoute.mockReturnValue(row);
  store.updateRoute.mockReturnValue(row);
});

it("keeps list, create and patch response fields identical and the watermark private", async () => {
  const list = await GET(new NextRequest("http://localhost/api/v1/bridges/bridge/routes"), context());
  const create = await POST(request("POST", { remote_jid: "*", agent_id: "agent", silent_mode: true }), context());
  const patch = await PATCH(request("PATCH", { label: "Synthetic" }), context());
  expect([list.status, create.status, patch.status]).toEqual([200, 201, 200]);
  await expect(list.json()).resolves.toEqual([expected]);
  await expect(create.json()).resolves.toEqual(expected);
  await expect(patch.json()).resolves.toEqual(expected);
});

it("retains missing-resource errors instead of trying to serialize absent rows", async () => {
  store.getBridge.mockReturnValue(null);
  store.getRoute.mockReturnValue(null);
  const list = await GET(new NextRequest("http://localhost/api/v1/bridges/bridge/routes"), context());
  const patch = await PATCH(request("PATCH", {}), context());
  expect([list.status, patch.status]).toEqual([404, 404]);
  await expect(list.json()).resolves.toEqual({ error: "not found" });
  await expect(patch.json()).resolves.toEqual({ error: "not found" });
});

it("retains distinct create and patch conflict messages", async () => {
  store.createRoute.mockImplementation(() => { throw new Error("UNIQUE agent_id"); });
  store.updateRoute.mockImplementation(() => { throw new Error("UNIQUE agent_id"); });
  const create = await POST(request("POST", { remote_jid: "*", agent_id: "agent" }), context());
  const patch = await PATCH(request("PATCH", { label: "Synthetic" }), context());
  expect([create.status, patch.status]).toEqual([409, 409]);
  await expect(create.json()).resolves.toEqual({
    error: "That agent is already the target of another route. Each agent can serve at most one chat.",
  });
  await expect(patch.json()).resolves.toEqual({ error: "That agent is already the target of another route." });
});
