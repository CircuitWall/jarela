import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-version-adoption-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { getDb } = await import("@/lib/db");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const {
  getVersionAdoptionState,
  recordVersionAdoptionWorkflowProgress,
  updateVersionAdoptionState,
} = await import("@/lib/stores/version-adoption");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  getDb().exec("DELETE FROM memory_store WHERE namespace='app-lifecycle'");
  getDb().exec("DELETE FROM agent_configs");
});

describe("version adoption state", () => {
  it("bootstraps the first version as a baseline after the default agent is known", () => {
    upsertAgentConfig({
      id: "default-agent",
      name: "Assistant",
      identity: "helper",
      instructions: "Be useful.",
      tools: [],
      is_default: true,
    });

    const state = getVersionAdoptionState("1.29.5");
    expect(state).toMatchObject({
      current_version: "1.29.5",
      previous_version: null,
      is_first_adoption: true,
      status: "pending",
      default_agent_id: "default-agent",
      default_agent_name: "Assistant",
    });
    expect(state.summary).toContain("Current version 1.29.5 baseline");
    expect(state.checklist.map((item) => item.id)).toEqual([
      "fetch-changes",
      "build-todo-list",
    ]);
  });

  it("records the current version after completing the baseline", () => {
    upsertAgentConfig({
      id: "default-agent",
      name: "Assistant",
      identity: "helper",
      instructions: "Be useful.",
      tools: [],
      is_default: true,
    });

    updateVersionAdoptionState("mark_done", "1.29.5");
    const next = getVersionAdoptionState("1.29.6");

    expect(next).toMatchObject({
      current_version: "1.29.6",
      previous_version: "1.29.5",
      is_first_adoption: false,
      status: "pending",
    });
  });

  it("starts an agent-driven adoption run with explicit two-phase instructions", () => {
    upsertAgentConfig({
      id: "default-agent",
      name: "Assistant",
      identity: "helper",
      instructions: "Be useful.",
      tools: [],
      is_default: true,
    });

    const running = updateVersionAdoptionState("start", "1.29.5");

    expect(running.status).toBe("running");
    expect(running.phase).toBe("impact_radius");
    expect(running.adoption_thread_id).toBeTruthy();
    expect(running.adoption_prompt).toContain("Phase 1");
    expect(running.adoption_prompt).toContain("Phase 2");
    expect(running.adoption_prompt).toContain("workflow_progress");
    expect(running.adoption_prompt).toContain('workflow_id: "version_adoption"');
    expect(running.adoption_prompt).toContain('item_id: "fetch-changes"');
    expect(running.adoption_prompt).toContain('item_id: "build-todo-list"');
    expect(running.adoption_prompt).toContain("Phase 2 adoption checklist");
    expect(running.adoption_prompt).toContain("If Phase 1 finds no adoption work");
    expect(running.checklist[0].status).toBe("checking");
  });

  it("records item-by-item adoption progress through the workflow helper", () => {
    upsertAgentConfig({
      id: "default-agent",
      name: "Assistant",
      identity: "helper",
      instructions: "Be useful.",
      tools: [],
      is_default: true,
    });

    updateVersionAdoptionState("start", "1.29.5");
    const checking = recordVersionAdoptionWorkflowProgress({
      phase: "impact_radius",
      item_id: "build-todo-list",
      status: "checking",
      summary: "building todos",
    }, "1.29.5");
    const adoption = recordVersionAdoptionWorkflowProgress({
      item_id: "build-todo-list",
      status: "done",
    }, "1.29.5");
    const done = recordVersionAdoptionWorkflowProgress({
      item_id: "tools",
      status: "done",
    }, "1.29.5");

    expect(checking.state.status).toBe("running");
    expect(checking.state.phase).toBe("impact_radius");
    expect(checking.state.summary).toBe("building todos");
    expect(adoption.state.phase).toBe("adoption");
    expect(adoption.state.checklist.map((item) => item.id)).toEqual(["instructions", "tools", "scheduled-work"]);
    expect(done.updated_item_id).toBe("tools");
    expect(done.state.checklist.find((item) => item.id === "tools")?.status).toBe("done");
  });

  it("blocks adoption until a default agent exists", () => {
    const state = getVersionAdoptionState("1.29.5");
    expect(state.status).toBe("blocked_no_default_agent");
    expect(state.default_agent_id).toBeNull();
    expect(state.error).toMatch(/No default agent/);
  });

  it("recovers a blocked first adoption after a default agent is created", () => {
    expect(getVersionAdoptionState("1.29.5").status).toBe("blocked_no_default_agent");
    upsertAgentConfig({
      id: "default-agent",
      name: "Assistant",
      identity: "helper",
      instructions: "Be useful.",
      tools: [],
      is_default: true,
    });

    const state = getVersionAdoptionState("1.29.5");
    expect(state.status).toBe("pending");
    expect(state.default_agent_id).toBe("default-agent");
  });

  it("keeps repeated starts idempotent for the same version", () => {
    upsertAgentConfig({
      id: "default-agent",
      name: "Assistant",
      identity: "helper",
      instructions: "Be useful.",
      tools: [],
      is_default: true,
    });

    const first = updateVersionAdoptionState("start", "1.29.5");
    const second = updateVersionAdoptionState("start", "1.29.5");

    expect(second.status).toBe("running");
    expect(second.adoption_thread_id).toBe(first.adoption_thread_id);
    expect(second.started_at).toBe(first.started_at);
  });

  it("dismisses the current version without creating a duplicate pending state", () => {
    upsertAgentConfig({
      id: "default-agent",
      name: "Assistant",
      identity: "helper",
      instructions: "Be useful.",
      tools: [],
      is_default: true,
    });

    const dismissed = updateVersionAdoptionState("dismiss", "1.29.5");
    const again = getVersionAdoptionState("1.29.5");

    expect(dismissed.status).toBe("dismissed");
    expect(again.status).toBe("dismissed");
    expect(again.current_version).toBe("1.29.5");
  });
});
