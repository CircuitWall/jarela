import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "jarela-advertisements-"));
process.env.JARELA_DB_DIR = root;
const refresh = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@/lib/agents/advertisement-service", () => ({ advertisementService: () => ({ refresh }) }));
const { getDb, closeDb } = await import("@/lib/db");
const { upsertAgentConfig, duplicateAgentConfig, deleteAgentConfig, compareAndSetAgentTools } = await import("./agent-configs");
const { getAdvertisement, putAdvertisement, getAdvertisementPolicy, setAdvertisementPolicy, reserveAdvertisementCall } = await import("./agent-advertisements");
const { defaultAdvertisementPolicy } = await import("@/lib/agents/advertisement-contract");
const { getMemory, putMemory, deleteMemory, listMemory } = await import("./memory");
const seed = () => upsertAgentConfig({ id: "specialist", name: "Specialist", identity: "Synthetic", instructions: "Review fixtures", tools: [] });
const ready = () => putAdvertisement({
  version: 1, generation_id: "synthetic-generation", agent_id: "specialist", enabled: true, status: "ready",
  source_fingerprint: "synthetic-source", policy_fingerprint: "synthetic-policy", updated_at: new Date().toISOString(), error: null,
  advertisement: { purpose: "Review fixture summaries", call_when: ["A summary needs review"], do_not_call_for: ["Live publication"], inputs: "Fixture text", output: "Checked summary", tools: [] },
});
beforeEach(() => {
  getDb().prepare("DELETE FROM memory_store WHERE namespace IN (?,?)").run("agent-advertisements", "app-settings");
  refresh.mockClear();
});
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });
describe("advertisement persistence and all shared config writes", () => {
  it("prevents generic memory from changing egress policy, corrupting state or exposing hidden identities", () => {
    seed(); ready();
    for (const [namespace, key] of [["agent-advertisements", "specialist"], ["app-settings", "agent-advertisement-policy"], ["app-settings", "agent-advertisement-usage"]]) {
      expect(() => putMemory(namespace, key, {})).toThrow("advertisement settings");
      expect(() => deleteMemory(namespace, key)).toThrow("advertisement settings");
      expect(() => getMemory(namespace, key)).toThrow("advertisement settings");
    }
    expect(listMemory().some((row) => row.namespace === "agent-advertisements")).toBe(false);
  });
  it("defaults disabled and encrypts descriptions at rest", () => {
    expect(getAdvertisementPolicy()).toEqual(defaultAdvertisementPolicy());
    seed(); ready();
    const row = getDb().prepare("SELECT value FROM memory_store WHERE namespace=? AND key=?").get("agent-advertisements", "specialist") as { value: string };
    expect(row.value).not.toContain("Review fixture summaries");
    expect(getAdvertisement("specialist")?.status).toBe("ready");
  });
  it("invalidates routing changes synchronously but not cosmetic/no-op saves", async () => {
    const agent = seed(); ready();
    setAdvertisementPolicy({ ...defaultAdvertisementPolicy(), enabled: true, model_config_name: "configured" });
    upsertAgentConfig({ id: agent.id, name: agent.name, identity: agent.identity, instructions: agent.instructions, tools: [], icon: "new-icon" });
    expect(getAdvertisement(agent.id)?.status).toBe("ready");
    expect(refresh).not.toHaveBeenCalled();
    upsertAgentConfig({ id: agent.id, name: agent.name, identity: agent.identity, instructions: "A new saved task", tools: [] });
    expect(getAdvertisement(agent.id)?.status).toBe("stale");
    expect(getAdvertisement(agent.id)?.advertisement).toBeNull();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledWith(agent.id));
  });
  it("covers duplicate, atomic tool grants and deletion without copying derived metadata", async () => {
    seed(); ready();
    setAdvertisementPolicy({ ...defaultAdvertisementPolicy(), enabled: true, model_config_name: "configured" });
    const copy = duplicateAgentConfig("specialist")!;
    expect(getAdvertisement(copy.id)).toBeNull();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledWith(copy.id));
    compareAndSetAgentTools("specialist", "[]", ["fixture_read"]);
    expect(getAdvertisement("specialist")?.status).toBe("stale");
    deleteAgentConfig("specialist");
    expect(getAdvertisement("specialist")).toBeNull();
  });
  it("does not invalidate or schedule for a rejected store write", () => {
    seed(); ready();
    expect(() => compareAndSetAgentTools("specialist", '["wrong"]', ["fixture_read"])).toThrow();
    expect(getAdvertisement("specialist")?.status).toBe("ready");
    expect(refresh).not.toHaveBeenCalled();
  });
  it("persists hourly reservations across reads and expires them deterministically", () => {
    expect(reserveAdvertisementCall(10000000, 2)).toBe(true);
    expect(reserveAdvertisementCall(10000001, 2)).toBe(true);
    expect(reserveAdvertisementCall(10000002, 2)).toBe(false);
    expect(reserveAdvertisementCall(13600002, 2)).toBe(true);
  });
});
