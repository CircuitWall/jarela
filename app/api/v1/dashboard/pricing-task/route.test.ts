import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  defaultAgent: { id: "assistant", name: "Jassy" } as { id: string; name: string } | null,
  task: null as Record<string, unknown> | null,
  createCalls: [] as Array<Record<string, unknown>>,
  updateCalls: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  startCalls: 0,
}));

vi.mock("@/lib/stores/agent-configs", () => ({
  getDefaultAgentConfig: () => state.defaultAgent,
  getAgentConfig: (id: string) => id === state.task?.agent_id ? { id, name: "Jassy" } : null,
}));
vi.mock("@/lib/stores/scheduled-tasks", () => ({
  getScheduledTask: () => state.task,
  createScheduledTask: (input: Record<string, unknown>) => {
    state.createCalls.push(input);
    state.task = {
      id: input.id,
      agent_id: input.agent_id,
      enabled: 1,
      next_run_at: "2026-10-12T07:00:00.000Z",
      schedule: input.schedule,
    };
    return state.task;
  },
  updateScheduledTask: (id: string, patch: Record<string, unknown>) => {
    state.updateCalls.push({ id, patch });
    if (!state.task || state.task.id !== id) return null;
    state.task = {
      ...state.task,
      ...patch,
      ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled ? 1 : 0 } : {}),
    };
    return state.task;
  },
}));
vi.mock("@/lib/scheduler", () => ({ startScheduler: () => { state.startCalls += 1; } }));

import { GET, POST } from "./route";

function request() {
  return new NextRequest("http://localhost/api/v1/dashboard/pricing-task", { method: "POST", body: "{}" });
}

describe("dashboard weekly pricing task", () => {
  beforeEach(() => {
    state.defaultAgent = { id: "assistant", name: "Jassy" };
    state.task = null;
    state.createCalls = [];
    state.updateCalls = [];
    state.startCalls = 0;
  });

  it("reports that setup is available when a default agent exists", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      configured: false,
      default_agent_configured: true,
      default_agent_name: "Jassy",
      enabled: false,
      schedule: null,
    });
  });

  it("creates one weekly task for the configured default agent", async () => {
    const response = await POST();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: true, enabled: true, task_agent_name: "Jassy" });
    expect(state.createCalls).toHaveLength(1);
    expect(state.createCalls[0]).toMatchObject({
      id: "jarela-weekly-pricing-refresh",
      agent_id: "assistant",
      kind: "cron",
      schedule: "0 9 * * 1",
      silent: true,
    });
    expect(state.startCalls).toBe(1);
  });

  it("is idempotent when the task already exists", async () => {
    await POST();
    const response = await POST();
    expect(response.status).toBe(200);
    expect(state.createCalls).toHaveLength(1);
  });

  it("resumes a paused task and assigns it to the current default agent", async () => {
    state.task = {
      id: "jarela-weekly-pricing-refresh",
      agent_id: "old-agent",
      enabled: 0,
      next_run_at: "2026-10-12T07:00:00.000Z",
    };

    const response = await POST();
    expect(response.status).toBe(200);
    expect(state.updateCalls).toEqual([{
      id: "jarela-weekly-pricing-refresh",
      patch: { agent_id: "assistant", enabled: true },
    }]);
    expect(await response.json()).toMatchObject({ configured: true, enabled: true });
  });

  it("requires a configured default agent", async () => {
    state.defaultAgent = null;
    const response = await POST();
    expect(response.status).toBe(409);
    expect(state.createCalls).toHaveLength(0);
  });
});