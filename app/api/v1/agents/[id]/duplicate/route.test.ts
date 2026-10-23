import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-agent-duplicate-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { upsertAgentConfig, getAgentConfig, listAgentConfigs, updateAgentDisplayFilters, getAgentDisplayFilters } =
  await import("@/lib/stores/agent-configs");
const { POST } = await import("./route");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function seedTunedAgent(id: string) {
  upsertAgentConfig({
    id,
    name: "Research Buddy",
    identity: "You research things.",
    instructions: "Always cite sources.",
    tools: ["web_search", "read_url"],
    model_config_name: "claude-main",
    is_default: true,
    history_limit: 20,
    never_reply: true,
    adaptive_persona_enabled: true,
    adaptive_mbti: "ENFP",
    adaptive_empathy: 91,
    voice_enabled: true,
    voice_name: "Puck",
    delegate_targets: ["helper"],
    context_tier_proportions: { hot: 1, warm: 2, facts: 3 },
    citation_strictness: "strict",
    tool_credentials: { web_search: "cred-1" },
    usage_strategy: "high_reasoning",
  });
  updateAgentDisplayFilters(id, { tool_use: false });
}

function call(id: string, body?: unknown) {
  const req = new NextRequest(`http://localhost/api/v1/agents/${id}/duplicate`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

describe("POST /api/v1/agents/[id]/duplicate", () => {
  it("copies every tuned setting into a new agent the user can start from", async () => {
    seedTunedAgent("research");
    const res = await call("research");
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).not.toBe("research");
    expect(body.name).toBe("Research Buddy (copy)");

    const source = getAgentConfig("research")!;
    const copy = getAgentConfig(body.id)!;
    const ignored = new Set(["id", "name", "is_default", "created_at", "updated_at"]);
    for (const key of Object.keys(source) as (keyof typeof source)[]) {
      if (ignored.has(key)) continue;
      expect({ key, value: copy[key] }).toEqual({ key, value: source[key] });
    }
    expect(getAgentDisplayFilters(body.id)!.tool_use).toBe(false);
  });

  it("never steals the default flag from the source agent", async () => {
    seedTunedAgent("default-src");
    const res = await call("default-src");
    const body = await res.json();
    expect(getAgentConfig(body.id)!.is_default).toBe(0);
    expect(getAgentConfig("default-src")!.is_default).toBe(1);
  });

  it("uses a requested name and leaves the source untouched", async () => {
    seedTunedAgent("named");
    const before = getAgentConfig("named")!;
    const res = await call("named", { name: "  Weekend Planner  " });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Weekend Planner");
    expect(getAgentConfig("named")).toEqual(before);
  });

  it("creates distinct agents when duplicated repeatedly", async () => {
    seedTunedAgent("repeat");
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add((await (await call("repeat")).json()).id);
    expect(ids.size).toBe(5);
  });

  it("returns 404 for an unknown agent and creates nothing", async () => {
    const before = listAgentConfigs().length;
    const res = await call("missing-agent");
    expect(res.status).toBe(404);
    expect(listAgentConfigs().length).toBe(before);
  });

  it("rejects a blank or non-string name", async () => {
    seedTunedAgent("bad-name");
    const before = listAgentConfigs().length;
    expect((await call("bad-name", { name: "   " })).status).toBe(400);
    expect((await call("bad-name", { name: 42 })).status).toBe(400);
    expect(listAgentConfigs().length).toBe(before);
  });
});
