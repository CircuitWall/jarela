import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DREAMING_SETTINGS_DEFAULTS } from "@/api/dreaming";

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  updateSettings: vi.fn(),
  setAgentEnabled: vi.fn(),
  start: vi.fn(),
  agent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/stores/agent-configs", () => ({ getAgentConfig: mocks.agent }));
vi.mock("@/lib/agents/dreaming", () => ({
  getDreamingOverview: mocks.overview,
  updateDreamingSettings: mocks.updateSettings,
  setAgentDreamingEnabled: mocks.setAgentEnabled,
  startDream: mocks.start,
}));

import { GET, PATCH, POST } from "./route";

const run = {
  id: "run-1",
  agent_id: "agent-a",
  kind: "light" as const,
  status: "running" as const,
  started_at: "2026-11-26T00:00:00.000Z",
  finished_at: null,
  summary: null,
  error: null,
  estimated_input_tokens: 0,
  estimated_output_tokens: 0,
  stats: null,
};
const overview = {
  settings: DREAMING_SETTINGS_DEFAULTS,
  running: null,
  agents: [{
    agent_id: "agent-a",
    name: "Agent A",
    is_default: true,
    enabled: true,
    last_light_dream_at: null,
    last_deep_dream_at: null,
    last_light_boundary_seq: null,
    last_error: null,
    light: { eligible: true, reason: null },
    deep: { eligible: false, reason: "deep_not_due" },
  }],
  runs: [],
};

function request(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/dreaming", {
    method,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.overview.mockReturnValue(overview);
  mocks.agent.mockReturnValue({ id: "agent-a" });
  mocks.updateSettings.mockReturnValue(DREAMING_SETTINGS_DEFAULTS);
  mocks.start.mockReturnValue({ started: true, run });
});

describe("dreaming route", () => {
  it("returns the overview", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(overview);
  });

  it("persists settings and per-agent opt-out", async () => {
    const settings = await PATCH(request("PATCH", { settings: { light_idle_minutes: 240 } }));
    expect(settings.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith({ light_idle_minutes: 240 });
    expect(await settings.json()).toEqual(overview);

    const agent = await PATCH(request("PATCH", { agent: { agent_id: "agent-a", enabled: false } }));
    expect(agent.status).toBe(200);
    expect(mocks.setAgentEnabled).toHaveBeenCalledWith("agent-a", false);
  });

  it("rejects an empty patch, out-of-range settings, and malformed JSON", async () => {
    expect((await PATCH(request("PATCH", {}))).status).toBe(400);
    expect((await PATCH(request("PATCH", { settings: { light_idle_minutes: 1 } }))).status).toBe(400);
    expect((await PATCH(request("PATCH", "{"))).status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects an unknown agent before writing or starting a dream", async () => {
    mocks.agent.mockReturnValue(null);
    expect((await PATCH(request("PATCH", { agent: { agent_id: "missing", enabled: false } }))).status).toBe(404);
    expect((await POST(request("POST", { agent_id: "missing", kind: "light" }))).status).toBe(404);
    expect(mocks.setAgentEnabled).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("starts a dream with 202 and forwards force", async () => {
    const response = await POST(request("POST", { agent_id: "agent-a", kind: "deep", force: true }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, run });
    expect(mocks.start).toHaveBeenCalledWith("agent-a", "deep", { force: true });
  });

  it("reports a running dream and an ineligible agent as conflicts", async () => {
    mocks.start.mockReturnValueOnce({ started: false, reason: "dream_running" });
    const running = await POST(request("POST", { agent_id: "agent-a", kind: "light" }));
    expect(running.status).toBe(409);
    expect((await running.json()).error).toContain("already running");

    mocks.start.mockReturnValueOnce({ started: false, reason: "not_idle" });
    const ineligible = await POST(request("POST", { agent_id: "agent-a", kind: "light" }));
    expect(ineligible.status).toBe(409);
    expect((await ineligible.json()).error).toContain("not_idle");
  });
});
