import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-workflow-progress-tool-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { getDb } = await import("@/lib/db");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const { workflowProgressTool } = await import("./workflow-progress");

function parse(raw: unknown) {
  return JSON.parse(String(raw)) as Record<string, unknown>;
}

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  getDb().exec("DELETE FROM memory_store WHERE namespace='app-lifecycle'");
  getDb().exec("DELETE FROM agent_configs");
  upsertAgentConfig({
    id: "default-agent",
    name: "Assistant",
    identity: "helper",
    instructions: "Be useful.",
    tools: [],
    is_default: true,
  });
});

describe("workflow_progress tool", () => {
  it("updates version adoption phase and item status", async () => {
    const out = parse(await workflowProgressTool.invoke({
      workflow_id: "version_adoption",
      phase: "impact_radius",
      item_id: "fetch-changes",
      status: "checking",
      detail: "checking instructions",
    }));

    expect(out.ok).toBe(true);
    expect(out.workflow_id).toBe("version_adoption");
    const state = out.state as { phase: string; status: string; checklist: Array<{ id: string; status: string }> };
    expect(state.status).toBe("running");
    expect(state.phase).toBe("impact_radius");
    expect(state.checklist.find((item) => item.id === "fetch-changes")?.status).toBe("checking");
  });

  it("swaps to the Phase 2 adoption checklist when adoption starts", async () => {
    const out = parse(await workflowProgressTool.invoke({
      workflow_id: "version_adoption",
      phase: "adoption",
    }));

    expect(out.ok).toBe(true);
    const state = out.state as { phase: string; checklist: Array<{ id: string }> };
    expect(state.phase).toBe("adoption");
    expect(state.checklist.map((item) => item.id)).toEqual(["instructions", "tools", "scheduled-work"]);
  });

  it("automatically starts Phase 2 when the Phase 1 todo list is built", async () => {
    const out = parse(await workflowProgressTool.invoke({
      workflow_id: "version_adoption",
      phase: "impact_radius",
      item_id: "build-todo-list",
      status: "done",
    }));

    expect(out.ok).toBe(true);
    const state = out.state as { phase: string; checklist: Array<{ id: string }> };
    expect(state.phase).toBe("adoption");
    expect(state.checklist.map((item) => item.id)).toEqual(["instructions", "tools", "scheduled-work"]);
  });

  it("rejects unsupported workflow ids", async () => {
    const out = parse(await workflowProgressTool.invoke({
      workflow_id: "integration_setup",
      phase: "impact_radius",
    }));

    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("unsupported workflow_id");
  });

  it("returns a structured error for unknown item ids", async () => {
    const out = parse(await workflowProgressTool.invoke({
      workflow_id: "version_adoption",
      item_id: "missing",
      status: "done",
    }));

    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("not found");
    expect(out.state).toBeTruthy();
  });
});