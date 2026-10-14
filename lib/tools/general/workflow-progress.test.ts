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
    // fetch-changes starts pre-completed (deterministic git diff at creation
    // time) — the existing shouldPreserveCompleted guard in
    // lib/stores/workflow-progress.ts correctly refuses to downgrade it
    // back to "checking".
    expect(state.checklist.find((item) => item.id === "fetch-changes")?.status).toBe("done");
  });

  it("swaps to the Phase 2 adoption checklist when adoption starts", async () => {
    const out = parse(await workflowProgressTool.invoke({
      workflow_id: "version_adoption",
      phase: "adoption",
    }));

    expect(out.ok).toBe(true);
    const state = out.state as {
      phase: string;
      checklist: Array<{ id: string; input: string; output: string; validation: string }>;
    };
    expect(state.phase).toBe("adoption");
    expect(state.checklist.map((item) => item.id)).toEqual(["instructions", "tools", "scheduled-work"]);
    for (const item of state.checklist) {
      expect(item.input).toBeTruthy();
      expect(item.output).toBeTruthy();
      expect(item.validation).toBeTruthy();
    }
  });

  it("automatically starts Phase 2 when the Phase 1 todo list is built", async () => {
    const out = parse(await workflowProgressTool.invoke({
      workflow_id: "version_adoption",
      phase: "impact_radius",
      item_id: "build-todo-list",
      status: "done",
      validation_evidence: "Every changed path is included or explicitly handled by the fallback.",
    }));

    expect(out.ok).toBe(true);
    const state = out.state as { phase: string; checklist: Array<{ id: string }> };
    expect(state.phase).toBe("adoption");
    expect(state.checklist.map((item) => item.id)).toEqual(["instructions", "tools", "scheduled-work"]);
  });

  it("accepts agent-created checklist snapshots", async () => {
    const out = parse(await workflowProgressTool.invoke({
      workflow_id: "integration_setup",
      phase: "verification",
      summary: "Connect and verify the provider",
      items: [
        {
          id: "check-prerequisites",
          label: "Check prerequisites",
          input: "Configured provider credentials",
          output: "Prerequisites report",
          validation: "Check required settings are present",
          validation_evidence: "Required settings were present",
          status: "done",
        },
        {
          id: "configure-provider",
          label: "Configure provider",
          input: "Prerequisites report",
          output: "Saved provider configuration",
          validation: "Read the saved configuration back",
          status: "checking",
        },
        {
          id: "verify-connection",
          label: "Verify connection",
          input: "Saved provider configuration",
          output: "Connection result",
          validation: "Run a provider health check and inspect its result",
        },
      ],
    }));

    expect(out.ok).toBe(true);
    expect(out.workflow_id).toBe("integration_setup");
    expect(out.state).toMatchObject({
      phase: "verification",
      summary: "Connect and verify the provider",
      checklist: [
        { id: "check-prerequisites", status: "done", validation_evidence: "Required settings were present" },
        { id: "configure-provider", status: "checking" },
        { id: "verify-connection", status: "pending" },
      ],
    });
  });

  it("requires observed validation evidence before marking an item done", async () => {
    const out = parse(await workflowProgressTool.invoke({
      workflow_id: "migration",
      items: [{
        id: "verify",
        label: "Verify migration",
        input: "Current database",
        output: "Migrated database",
        validation: "Run migration tests",
        status: "done",
      }],
    }));

    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("observed validation_evidence");

    const systemWorkflow = parse(await workflowProgressTool.invoke({
      workflow_id: "version_adoption",
      item_id: "build-todo-list",
      status: "done",
    }));
    expect(systemWorkflow.ok).toBe(false);
    expect(String(systemWorkflow.error)).toContain("observed validation_evidence");
  });

  it("refuses to complete version adoption while checklist items are unverified", async () => {
    const out = parse(await workflowProgressTool.invoke({
      workflow_id: "version_adoption",
      phase: "complete",
    }));

    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("every checklist item is validated or skipped");
  });

  it("requires full snapshots and refuses completion while items are open", async () => {
    const missingItems = parse(await workflowProgressTool.invoke({ workflow_id: "migration" }));
    expect(missingItems.ok).toBe(false);
    expect(String(missingItems.error)).toContain("complete current items checklist");

    const openItems = parse(await workflowProgressTool.invoke({
      workflow_id: "migration",
      phase: "complete",
      items: [{
        id: "verify",
        label: "Verify migration",
        input: "Current database",
        output: "Migrated database",
        validation: "Run migration tests",
        status: "checking",
      }],
    }));
    expect(openItems.ok).toBe(false);
    expect(String(openItems.error)).toContain("items remain open");

    const partialItemUpdate = parse(await workflowProgressTool.invoke({
      workflow_id: "migration",
      item_id: "verify",
      status: "done",
      items: [{
        id: "verify",
        label: "Verify migration",
        input: "Current database",
        output: "Migrated database",
        validation: "Run migration tests",
        status: "checking",
      }],
    }));
    expect(partialItemUpdate.ok).toBe(false);
    expect(String(partialItemUpdate.error)).toContain("complete items checklist");
  });

  it("returns a structured error for unknown item ids", async () => {
    const out = parse(await workflowProgressTool.invoke({
      workflow_id: "version_adoption",
      item_id: "missing",
      status: "done",
      validation_evidence: "Attempted lookup returned no item.",
    }));

    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("not found");
    expect(out.state).toBeTruthy();
  });
});