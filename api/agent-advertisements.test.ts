import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
const root = mkdtempSync(join(tmpdir(), "jarela-advertisement-api-"));
vi.stubEnv("JARELA_DB_DIR", root);
const chat = vi.hoisted(() => vi.fn());
vi.mock("@/lib/providers", () => ({ getProvider: () => ({ chat }) }));
vi.mock("@/lib/tools", () => ({
  getAllToolCatalogAsync: async () => [],
  authorizedAgentToolNames: () => [],
}));
const { closeDb } = await import("@/lib/db");
const { upsertAgentConfig, getAgentConfig, deleteAgentConfig } = await import("@/lib/stores/agent-configs");
const { upsertModelConfig } = await import("@/lib/stores/model-config");
const { getAdvertisement, getAdvertisementPolicy } = await import("@/lib/stores/agent-advertisements");
const { advertisementService } = await import("@/lib/agents/advertisement-service");
const { defaultAdvertisementPolicy } = await import("@/lib/agents/advertisement-contract");
const { GET, POST, PUT } = await import("@/app/api/v1/agent-advertisements/route");
const memory = await import("@/app/api/v1/memory/route");
const memoryItem = await import("@/app/api/v1/memory/[namespace]/[key]/route");
const id = "synthetic-specialist";
function req(method = "GET", data?: unknown, host = "localhost", path = "") {
  return new NextRequest(`http://localhost/api/v1/agent-advertisements${path}`, {
    method, headers: { host, "Content-Type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
const output = {
  purpose: "Review synthetic fixtures", call_when: ["A synthetic summary needs review"],
  do_not_call_for: ["Unrelated changes"], inputs: "Synthetic text", output: "A reviewed summary", tools: [],
};
afterAll(async () => { await advertisementService().close(); closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
describe("trusted advertisement API integration", () => {
  it("persists config independently, requires explicit model/egress policy and never falls back", async () => {
    upsertAgentConfig({ id, name: "Synthetic specialist", identity: "Fixture reviewer", instructions: "Review synthetic data", tools: [] });
    const response = await GET(req("GET", undefined, "localhost", `?agent_id=${id}`));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ policy: { enabled: false }, advertisement: { status: "disabled" } });
    expect(chat).not.toHaveBeenCalled();
    const invalid = await PUT(req("PUT", { policy: { ...defaultAdvertisementPolicy(), enabled: true, model_config_name: "missing" } }));
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("cache-control")).toBe("no-store");
    expect(getAgentConfig(id)).not.toBeNull();
    expect(getAdvertisementPolicy().enabled).toBe(false);
    expect(chat).not.toHaveBeenCalled();
  });
  it("uses only committed sources and displays validated generated state after asynchronous work", async () => {
    upsertModelConfig("advertisement-fixture", "synthetic", "fixture-model", {}, false);
    chat.mockResolvedValue({ stream: (async function* () { yield JSON.stringify(output); })() });
    expect((await PUT(req("PUT", { policy: { ...defaultAdvertisementPolicy(), enabled: true, model_config_name: "advertisement-fixture" } }))).status).toBe(200);
    await advertisementService().settle();
    expect(getAdvertisement(id)).toMatchObject({ status: "ready", advertisement: output });
    const call = chat.mock.calls[0];
    expect(call[0]).toBe("fixture-model");
    expect(call[1][1].content).toContain("Review synthetic data");
    expect(call[1][1].content).not.toMatch(/conversation|credential|api_key/);
    expect(call[2].max_tokens).toBe(1024);
    const action = await POST(req("POST", { agent_id: id, action: "disable" }));
    expect(await action.json()).toMatchObject({ advertisement: { enabled: false, status: "disabled", advertisement: null } });
    expect(chat).toHaveBeenCalledTimes(1);
  });
  it("rejects foreign local mutation, authority extras, malformed payloads and absent agents", async () => {
    const refused = await GET(req("GET", undefined, "remote.invalid"));
    expect(refused.status).toBe(403);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect((await POST(req("POST", { agent_id: id, action: "regenerate" }, "remote.invalid"))).status).toBe(403);
    expect((await PUT(req("PUT", { policy: defaultAdvertisementPolicy(), authority: "grant" }))).status).toBe(400);
    expect((await POST(req("POST", { agent_id: id, action: "enable", instructions: "unsaved" }))).status).toBe(400);
    expect((await POST(req("POST", { agent_id: "missing", action: "regenerate" }))).status).toBe(404);
    deleteAgentConfig(id);
    expect(getAdvertisement(id)).toBeNull();
  });
  it.each([
    ["agent-advertisements", "private-agent"],
    ["app-settings", "agent-advertisement-policy"],
    ["app-settings", "agent-advertisement-usage"],
  ])("rejects generic memory mutation of owned metadata %s/%s", async (namespace, key) => {
    const params = { params: Promise.resolve({ namespace, key }) };
    expect((await memory.POST(req("POST", { namespace, key, value: {} }))).status).toBe(403);
    expect((await memoryItem.PUT(req("PUT", { value: {} }), params)).status).toBe(403);
    expect((await memoryItem.DELETE(req("DELETE"), params)).status).toBe(403);
    if (namespace === "agent-advertisements") {
      expect((await memory.GET(req("GET", undefined, "localhost", "?namespace=agent-advertisements"))).status).toBe(403);
    }
    expect(getAdvertisementPolicy().enabled).toBe(true);
  });
});
