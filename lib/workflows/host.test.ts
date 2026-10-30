import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseWorkflowDefinition } from "./definition";
import { createWorkflowHost } from "./host";

const state = vi.hoisted(() => ({ permitted: true, capability: "read", action: "operation", execute: vi.fn(), script: vi.fn() }));
vi.mock("@/lib/stores/agent-configs", () => ({
  getAgentConfig: () => ({ id: "agent" }), getAgentToolCredentials: () => ({}),
}));
vi.mock("@/lib/stores/threads", () => ({ getOrCreateAgentThread: () => ({ thread_id: "synthetic-thread" }) }));
vi.mock("@/lib/tools", () => ({
  getAllToolCatalogAsync: async () => [{ name: state.action, capability: state.capability, permission: state.permitted ? "enabled" : "disabled" }],
  applyAgentPermissionsToCatalog: (items: unknown) => items, executeTool: state.execute,
}));
vi.mock("@/lib/skills/execution-service", () => ({ skillExecutionService: () => ({ request: state.script }) }));
const schema = { type: "object", properties: {}, additionalProperties: true };
function step(effect: "read" | "write" = "read") {
  return parseWorkflowDefinition(JSON.stringify({ schemaVersion: 1, id: "synthetic", steps: [{
    id: "first", action: "operation", kind: "tool", effect, input: { from: "literal", value: {} },
    inputSchema: schema, outputSchema: schema, ...(effect === "write" ? { reconcileAction: "operation" } : {}),
  }] })).steps[0];
}
const host = () => createWorkflowHost({ agentId: "agent", workspace: "workspace", runId: "run" });
const context = { agentId: "agent", workspace: "workspace", runId: "run", revision: "a".repeat(64), stepId: "first", version: 1, invocationJson: "{}" };
beforeEach(() => {
  vi.clearAllMocks(); state.permitted = true; state.capability = "read"; state.action = "operation"; state.execute.mockResolvedValue({ observed: true });
});
describe("production workflow host", () => {
  it("uses configured concrete typed tools and checks effects before invoking", async () => {
    expect(await host().execute(step(), {}, new AbortController().signal, context)).toMatchObject({
      kind: "output", json: '{"observed":true}', origin: "tool",
    });
    expect(state.execute).toHaveBeenCalledWith("operation", {}, expect.objectContaining({
      thread_id: "synthetic-thread", workspace: { root: "workspace", scoped: true },
      await_tool_settlement: true,
    }));
    state.capability = "write";
    expect(await host().execute(step(), {}, new AbortController().signal, context)).toEqual({ kind: "denied" });
    expect(state.execute).toHaveBeenCalledOnce();
    state.permitted = false;
    expect(await host().execute(step("write"), {}, new AbortController().signal, context)).toEqual({ kind: "denied" });
  });
  it("never turns an explicit write failure into safe retry or observed success", async () => {
    state.capability = "write"; state.execute.mockResolvedValue({ error: "Synthetic ambiguous effect" });
    expect(await host().execute(step("write"), {}, new AbortController().signal, context)).toEqual({ kind: "unknown" });
    await expect(host().observe!(step("write"), {}, new AbortController().signal, context)).rejects.toThrow(/declared effect/);
    state.capability = "read"; state.execute.mockResolvedValue({ saved: true });
    const signal = new AbortController().signal;
    expect(await host().observe!(step("write"), {}, signal, context)).toMatchObject({ outputJson: '{"saved":true}' });
    expect(state.execute).toHaveBeenLastCalledWith("operation", {}, expect.objectContaining({
      signal, await_tool_settlement: false,
    }));
  });
  it("uses a separate consumed workflow script grant and checked runner result", async () => {
    state.script.mockResolvedValue({ status: "finished", result: { status: "succeeded", output: { ok: true }, revision: "b".repeat(64) } });
    const script = { ...step(), kind: "script" as const, action: "plan_memory_cleanup" };
    const signal = new AbortController().signal;
    expect(await host().execute(script, {}, signal, context)).toMatchObject({ kind: "output", origin: "script" });
    expect(state.script).toHaveBeenCalledWith(expect.objectContaining({
      skillId: "memory-organization", signal, workflow: { runId: "run", revision: context.revision, invocationJson: "{}", stepId: "first" },
    }));
    state.script.mockResolvedValue({ status: "finished", result: { status: "failed" } });
    expect(await host().execute(script, {}, signal, context)).toEqual({ kind: "unknown" });
  });
  it("preserves model-generated output labels for known delegation tools", async () => {
    state.action = "delegate_to_agent"; state.capability = "execute";
    expect(await host().execute({ ...step("write"), action: state.action }, {}, new AbortController().signal, context))
      .toMatchObject({ kind: "output", origin: "model_generated" });
  });
});
