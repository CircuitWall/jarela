import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-bridges-"));
process.env.JARELA_DB_DIR = tmpRoot;

const store = await import("./bridges");
const { getDb } = await import("@/lib/db");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe("bridges store", () => {
  beforeEach(() => {
    const db = getDb();
    db.exec("DELETE FROM bridge_routes; DELETE FROM bridge_ignores; DELETE FROM bridges;");
  });

  it("keeps each chat's watermark monotonic and isolated from other chats", () => {
    const b = store.createBridge({ kind: "whatsapp", name: "WA" });
    store.createRoute({ bridge_id: b.id, remote_jid: "a@s.whatsapp.net", agent_id: "agent-1" });
    store.createRoute({ bridge_id: b.id, remote_jid: "b@s.whatsapp.net", agent_id: "agent-2" });

    store.bumpRouteLastSeenTs(b.id, "a@s.whatsapp.net", 2_000);
    store.bumpRouteLastSeenTs(b.id, "a@s.whatsapp.net", 1_000);
    store.bumpRouteLastSeenTs(b.id, "a@s.whatsapp.net", Number.NaN);
    store.bumpRouteLastSeenTs(b.id, "a@s.whatsapp.net", -5);
    store.bumpRouteLastSeenTs(b.id, "unrouted@s.whatsapp.net", 9_000);

    expect(store.getRouteLastSeenTsMap(b.id)).toEqual(new Map([["a@s.whatsapp.net", 2_000]]));
  });

  it("scopes watermarks to their bridge", () => {
    const one = store.createBridge({ kind: "whatsapp", name: "one" });
    const two = store.createBridge({ kind: "whatsapp", name: "two" });
    store.createRoute({ bridge_id: one.id, remote_jid: "x@s.whatsapp.net", agent_id: "agent-3" });
    store.createRoute({ bridge_id: two.id, remote_jid: "x@s.whatsapp.net", agent_id: "agent-4" });
    store.bumpRouteLastSeenTs(one.id, "x@s.whatsapp.net", 5_000);
    expect(store.getRouteLastSeenTsMap(two.id).size).toBe(0);
  });

  it("deletes a bridge together with its routes and ignores", () => {
    const b = store.createBridge({ kind: "whatsapp", name: "WA" });
    const route = store.createRoute({ bridge_id: b.id, remote_jid: "*", agent_id: "agent-5" });
    store.addIgnore({ bridge_id: b.id, remote_jid: "spam@s.whatsapp.net" });

    expect(store.deleteBridge(b.id)).toBe(true);
    expect(store.getRoute(route.id)).toBeNull();
    expect(store.isIgnored(b.id, "spam@s.whatsapp.net")).toBe(false);
    expect(store.deleteBridge(b.id)).toBe(false);
  });

  it("rejects a duplicate ignore entry and removes only the matching chat", () => {
    const b = store.createBridge({ kind: "whatsapp", name: "WA" });
    store.addIgnore({ bridge_id: b.id, remote_jid: "a@s.whatsapp.net", label: "A" });
    store.addIgnore({ bridge_id: b.id, remote_jid: "b@s.whatsapp.net" });
    expect(() => store.addIgnore({ bridge_id: b.id, remote_jid: "a@s.whatsapp.net" })).toThrow(/UNIQUE/);

    expect(store.removeIgnore(b.id, "a@s.whatsapp.net")).toBe(true);
    expect(store.removeIgnore(b.id, "a@s.whatsapp.net")).toBe(false);
    expect(store.listIgnores(b.id).map((i) => i.remote_jid)).toEqual(["b@s.whatsapp.net"]);
  });

  it("applies partial updates without clobbering nullable fields", () => {
    const b = store.createBridge({ kind: "whatsapp", name: "WA" });
    store.updateBridge(b.id, { last_error: "boom", paired_id: "me" });
    const updated = store.updateBridge(b.id, { status: "connected", forward_group_profile_updates: 0 });
    expect(updated).toMatchObject({ last_error: "boom", paired_id: "me", status: "connected", forward_group_profile_updates: 0 });
    expect(store.updateBridge(b.id, { last_error: null })?.last_error).toBeNull();
    expect(store.getBridge(b.id)).toMatchObject({ last_error: null, paired_id: "me", forward_group_participants_updates: 1 });
    expect(store.updateBridge("missing", { name: "x" })).toBeNull();

    const route = store.createRoute({ bridge_id: b.id, remote_jid: "a@s.whatsapp.net", agent_id: "agent-6", label: "A", silent_mode: true });
    expect(store.updateRoute(route.id, { respond_to: "user" })).toMatchObject({ label: "A", silent_mode: 1, respond_to: "user" });
    expect(store.updateRoute(route.id, { silent_mode: false, label: null })).toMatchObject({ label: null, silent_mode: 0 });
    expect(store.findRoute(b.id, "a@s.whatsapp.net")).toMatchObject({ silent_mode: 0, respond_to: "user", label: null });
  });
});
