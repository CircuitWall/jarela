import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-version-adoption-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { getDb } = await import("@/lib/db");
const { putMemory } = await import("@/lib/stores/memory");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const {
  getVersionAdoptionState,
  recordVersionAdoptionWorkflowProgress,
  updateVersionAdoptionState,
  VersionAdoptionRequestError,
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
    for (const item of state.checklist) {
      expect(item.input.trim()).not.toBe("");
      expect(item.output.trim()).not.toBe("");
      expect(item.validation.trim()).not.toBe("");
    }
    expect(state.checklist[0].validation_evidence).toContain("first adoption");
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
    const completed = getVersionAdoptionState("1.29.5");
    expect(completed.checklist.every((item) => item.status === "done" && item.validation_evidence)).toBe(true);
    const next = getVersionAdoptionState("1.29.6");

    expect(next).toMatchObject({
      current_version: "1.29.6",
      previous_version: "1.29.5",
      is_first_adoption: false,
      status: "pending",
    });
  });

  it("requires review for legacy completed items that have no validation evidence", () => {
    const initial = getVersionAdoptionState("1.29.5");
    const legacyState = {
      ...initial,
      checklist: initial.checklist.map(({ input: _input, output: _output, validation: _validation, validation_evidence: _evidence, ...item }) => ({
        ...item,
        status: "done",
      })),
      last_adopted_version: null,
    };
    putMemory("app-lifecycle", "version_adoption_state", legacyState);

    const recovered = getVersionAdoptionState("1.29.5");
    expect(recovered.checklist.every((item) => item.status === "needs_attention")).toBe(true);
    expect(recovered.checklist[0].reason).toContain("no validation evidence");

    const confirmed = updateVersionAdoptionState("mark_done", "1.29.5");
    expect(confirmed.checklist.every((item) => item.status === "done" && item.validation_evidence)).toBe(true);
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
    expect(running.adoption_prompt).toContain("fetch-changes");
    expect(running.adoption_prompt).toContain('item_id: "build-todo-list"');
    expect(running.adoption_prompt).toContain("Phase 2 adoption checklist");
    expect(running.adoption_prompt).toContain("expected output, and validation criteria");
    expect(running.adoption_prompt).toContain("validation_evidence");
    expect(running.adoption_prompt).toContain("If Phase 1 finds no adoption work");
    // fetch-changes is resolved deterministically at creation time (git diff),
    // never left for the agent to fetch/infer — build-todo-list is the item
    // that actually needs the agent's work.
    expect(running.checklist[0].id).toBe("fetch-changes");
    expect(running.checklist[0].status).toBe("done");
    expect(running.checklist[1].id).toBe("build-todo-list");
    expect(running.checklist[1].status).toBe("checking");
    expect(running.checklist[1].attempts).toBe(1);
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
      validation_evidence: "Every changed path is included or explicitly handled by the fallback.",
    }, "1.29.5");
    const done = recordVersionAdoptionWorkflowProgress({
      item_id: "tools",
      status: "done",
      validation_evidence: "Tool and permission checks were run against the changed files.",
    }, "1.29.5");

    expect(checking.state.status).toBe("running");
    expect(checking.state.phase).toBe("impact_radius");
    expect(checking.state.summary).toBe("building todos");
    expect(adoption.state.phase).toBe("adoption");
    expect(adoption.state.checklist.map((item) => item.id)).toEqual(["instructions", "tools", "scheduled-work"]);
    expect(done.updated_item_id).toBe("tools");
    expect(done.state.checklist.find((item) => item.id === "tools")).toMatchObject({
      status: "done",
      validation_evidence: "Tool and permission checks were run against the changed files.",
    });
  });

  it("builds adaptation items and prompt hints from bundled release changesets", () => {
    upsertAgentConfig({
      id: "default-agent",
      name: "Assistant",
      identity: "helper",
      instructions: "Be useful.",
      tools: [],
      is_default: true,
    });
    updateVersionAdoptionState("mark_done", "2.0.5");

    const pending = getVersionAdoptionState("2.2.1");
    expect(pending.previous_version).toBe("2.0.5");
    expect(pending.checklist[0]).toMatchObject({ id: "fetch-changes", status: "done" });
    expect(pending.checklist[0].validation_evidence).toContain("bundled release changesets for 2.1.0, 2.2.0, 2.2.1");
    expect(pending.stale_prompt_risks).toEqual(expect.arrayContaining([
      "Adapt agent settings to tool changes",
      "Adapt scheduled task and watcher prompts",
      "Adapt agent instructions and skills",
    ]));

    const running = updateVersionAdoptionState("start", "2.2.1");
    const prompt = running.adoption_prompt ?? "";
    expect(prompt).toContain("read deterministically by the system from the bundled release changesets");
    expect(prompt).toContain("Release changesets — model-facing prompt and tool description/schema changes from 2.0.5 to 2.2.1:");
    expect(prompt).toContain("tool `workflow_progress`");
    expect(prompt).toContain("params added: validation_evidence");
    expect(prompt).toContain("apply an edit only after the user approves it");
    expect(prompt).toContain("https://circuitwall.github.io/jarela/CHANGELOG/");
    expect(prompt).toContain("https://circuitwall.github.io/jarela/adoption/");
    expect(prompt).toContain("https://circuitwall.github.io/jarela/adoption/changesets.json");
    expect(prompt).toContain("Require schema_version 1 and complete, untruncated JSON");
    expect(prompt).toContain("Ignore Unreleased and future versions");
    expect(prompt).toContain("Bundled changesets remain authoritative");
    expect(prompt).toContain("Never claim the website was checked without a successful tool result");
    expect(prompt).not.toContain("Do not independently fetch");
    expect(prompt).not.toContain("partial");

    const adoption = recordVersionAdoptionWorkflowProgress({
      item_id: "build-todo-list",
      status: "done",
      validation_evidence: "Every changed prompt and tool is covered by an adapt item.",
    }, "2.2.1");
    const ids = adoption.state.checklist.map((item) => item.id);
    expect(ids).toEqual(["adapt-settings", "adapt-task-prompts", "adapt-instructions-skills"]);
    for (const item of adoption.state.checklist) {
      expect(item.input.trim()).not.toBe("");
      expect(item.output.trim()).not.toBe("");
      expect(item.validation).toMatch(/re-(read|list)/);
    }
    expect(adoption.state.checklist[0].affected_files).toContain("tool:workflow_progress");
  });

  it("retries a single adoption step with a focused prompt and keeps other steps", () => {
    upsertAgentConfig({
      id: "default-agent",
      name: "Assistant",
      identity: "helper",
      instructions: "Be useful.",
      tools: [],
      is_default: true,
    });
    updateVersionAdoptionState("mark_done", "2.0.5");
    updateVersionAdoptionState("start", "2.2.1");
    recordVersionAdoptionWorkflowProgress({
      item_id: "build-todo-list",
      status: "done",
      validation_evidence: "Every changed prompt and tool is covered.",
    }, "2.2.1");
    recordVersionAdoptionWorkflowProgress({
      phase: "adoption",
      item_id: "adapt-settings",
      status: "done",
      validation_evidence: "Re-read agent settings; no removed tools referenced.",
    }, "2.2.1");
    recordVersionAdoptionWorkflowProgress({
      phase: "adoption",
      item_id: "adapt-task-prompts",
      status: "needs_attention",
    }, "2.2.1");

    const retried = updateVersionAdoptionState("retry", "2.2.1", "adapt-settings");
    expect(retried.status).toBe("running");
    expect(retried.phase).toBe("adoption");
    const settings = retried.checklist.find((item) => item.id === "adapt-settings");
    expect(settings?.status).toBe("checking");
    expect(settings?.attempts).toBe(1);
    expect(settings?.validation_evidence).toBeUndefined();
    expect(retried.checklist.find((item) => item.id === "adapt-task-prompts")?.status).toBe("needs_attention");

    const prompt = retried.adoption_prompt ?? "";
    expect(prompt).toContain("Retry one Jarela version adoption step for upgrade from 2.0.5 to 2.2.1");
    expect(prompt).toContain("Step: adapt-settings");
    expect(prompt).toContain('item_id: "adapt-settings"');
    expect(prompt).toContain('phase: "adoption"');
    expect(prompt).toContain("Release changesets:");
    expect(prompt).not.toContain("Phase 1 — impact radius analysis");

    expect(() => updateVersionAdoptionState("retry", "2.2.1", "missing-step")).toThrow(VersionAdoptionRequestError);
    expect(() => updateVersionAdoptionState("retry", "2.2.1", "fetch-changes")).toThrow(VersionAdoptionRequestError);
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
