import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { registeredCapability } from "../runtime/registry";
import { runWorkflowTool, inspectWorkflowTool, listWorkflowsTool, advanceWorkflowTool,
  cancelWorkflowTool, reconcileWorkflowTool } from "./workflows";

const state = vi.hoisted(() => ({
  workspace: "synthetic-workspace", create: vi.fn(), inspect: vi.fn(), list: vi.fn(),
  advance: vi.fn(), cancel: vi.fn(), reconcile: vi.fn(),
}));
vi.mock("@/lib/stores/threads", () => ({ getThread: (id: string) => id === "thread" ? { agent_id: "agent" } : null }));
vi.mock("../filesystem/workspace-context", () => ({ currentWorkspace: () => state.workspace ? { root: state.workspace } : null }));
vi.mock("@/lib/workflows/service", () => ({ getWorkflowService: () => state }));
const config = { configurable: { thread_id: "thread" }, signal: new AbortController().signal };
const id = "00000000-0000-4000-8000-000000000001";
const parse = (value: unknown) => JSON.parse(String(value));
beforeEach(() => {
  vi.clearAllMocks(); state.workspace = "synthetic-workspace";
  state.create.mockReturnValue({ id, version: 1 });
  state.advance.mockResolvedValue({ id, version: 1, phase: "ready", executionApproval: { kind: "approval_required" } });
  state.inspect.mockReturnValue({ id, version: 1, phase: "waiting" });
});
describe("workflow agent tools", () => {
  it("registers separate scoped tools and exposes actual provider-facing contracts", () => {
    for (const tool of [inspectWorkflowTool, listWorkflowsTool]) expect(registeredCapability(tool.name)).toBe("read");
    for (const tool of [runWorkflowTool, advanceWorkflowTool, cancelWorkflowTool, reconcileWorkflowTool]) expect(registeredCapability(tool.name)).toBe("execute");
    expect(registeredCapability("answer_workflow")).toBeUndefined();
    for (const tool of [runWorkflowTool, inspectWorkflowTool, listWorkflowsTool, advanceWorkflowTool, cancelWorkflowTool, reconcileWorkflowTool]) {
      const schema = convertToOpenAITool(tool);
      expect(schema.function.parameters.type).toBe("object");
      if (process.env.JARELA_PROMPT_DUMP === "1") {
        mkdirSync(join(process.cwd(), ".prompts"), { recursive: true });
        writeFileSync(join(process.cwd(), ".prompts", `tool.${tool.name}.json`), JSON.stringify(schema, null, 2));
      }
    }
    expect(runWorkflowTool.description).toMatch(/pending approval is not success/i);
    expect(runWorkflowTool.description).toMatch(/never invent answers/i);
  });
  it("passes the exact invocation and agent/workspace scope, without treating approval as completion", async () => {
    const output = parse(await runWorkflowTool.invoke({ definition_json: "{}", invocation_json: '{ "exact": true }' }, config));
    expect(output.phase).toBe("ready");
    expect(state.create).toHaveBeenCalledWith("agent", "{}", '{ "exact": true }', "synthetic-workspace");
    expect(state.advance).toHaveBeenCalledWith("agent", id, 1, expect.any(AbortSignal));
    expect(parse(await inspectWorkflowTool.invoke({ id }, config)).phase).toBe("waiting");
    await cancelWorkflowTool.invoke({ id, version: 1 }, config);
    expect(state.cancel).toHaveBeenCalledWith("agent", id, 1);
    await reconcileWorkflowTool.invoke({ id, version: 1 }, config);
    expect(state.reconcile).toHaveBeenCalledWith("agent", id, 1, expect.any(AbortSignal));
  });
  it("reports missing context and rejects caller assertions in place of observed reconciliation", async () => {
    expect(parse(await inspectWorkflowTool.invoke({ id })).error).toMatch(/agent thread/);
    state.workspace = "";
    expect(parse(await runWorkflowTool.invoke({ definition_json: "{}" }, config)).error).toMatch(/workspace/);
    state.reconcile.mockRejectedValue(new Error("No declared read-back action"));
    expect(parse(await reconcileWorkflowTool.invoke({ id, version: 1 }, config)).error).toMatch(/read-back/);
    const schema = convertToOpenAITool(reconcileWorkflowTool);
    expect(schema.function.parameters.properties).not.toHaveProperty("output");
    expect(schema.function.parameters.properties).not.toHaveProperty("answer");
  });
});
