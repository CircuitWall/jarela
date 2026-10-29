import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarela-test-artifact-proposals-"));
process.env.JARELA_DB_DIR = root;
afterAll(async () => {
  const { closeDb } = await import("@/lib/db");
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

const { proposeConfigChangeTool, checkProposalTool } = await import("@/lib/tools/system/propose");
const { applyAction } = await import("./proposals");
const { createThread } = await import("@/lib/stores/threads");
const { getPendingAction, reservePendingApproval, setActionStatus } = await import("@/lib/stores/pending-actions");
const { createSkillRepo, updateSkillRepo } = await import("@/lib/stores/skill-repos");
const { getSkill, writeSkill } = await import("@/lib/skills");
const { createScheduledTask, getScheduledTask, updateScheduledTask } = await import("@/lib/stores/scheduled-tasks");
const { createWatcher, getWatcher, updateWatcher } = await import("@/lib/stores/watchers");
const { validateArtifactProposal } = await import("./artifact-proposals");
const { registerScript } = await import("@/lib/triggers/scripts");
registerScript("reaction.test", async () => ({ preview: "Synthetic result" }));

const repo = createSkillRepo({ path: join(root, "skills") });
const thread = createThread("artifact-agent");
const config = { configurable: { thread_id: thread.thread_id } };
type Kind = "write_skill" | "update_scheduled_task_prompt" | "update_watcher_prompt";
async function propose(kind: Kind, payload: Record<string, unknown>) {
  return JSON.parse(String(await proposeConfigChangeTool.invoke({ kind, payload, reason: "Synthetic compatibility update" }, config)));
}

describe("artifact proposals through the existing approval path", () => {
  it("queues a skill without writing, applies once on approval, and exposes the outcome", async () => {
    const payload = { id: "approved-skill", expected_content: null, content: "# Approved\n\nNew guidance." };
    const queued = await propose("write_skill", payload);
    expect(queued.status).toBe("pending");
    expect(getSkill(payload.id)).toBeNull();
    const action = getPendingAction(queued.proposal_id)!;
    expect(JSON.parse(action.payload)).toEqual({ ...payload, writable_repo_id: repo.id });
    expect(reservePendingApproval(action.id)?.id).toBe(action.id);
    expect(reservePendingApproval(action.id)).toBeNull();
    const result = await applyAction(action.kind, JSON.parse(action.payload));
    expect(result.ok).toBe(true);
    setActionStatus(action.id, "approved", result.detail);
    expect(getSkill(payload.id)?.content).toBe(payload.content);
    const status = JSON.parse(String(await checkProposalTool.invoke({ proposal_id: action.id })));
    expect(status.status).toBe("approved");
  });

  it("denies without changing the existing skill", async () => {
    writeSkill("denied-skill", "# Before");
    const queued = await propose("write_skill", {
      id: "denied-skill", expected_content: "# Before", content: "# After",
    });
    setActionStatus(queued.proposal_id, "denied", "User declined");
    expect(reservePendingApproval(queued.proposal_id)).toBeNull();
    expect(getSkill("denied-skill")?.content).toBe("# Before");
  });

  it("rejects skill edits made stale after queuing", async () => {
    writeSkill("stale-skill", "# Before");
    const queued = await propose("write_skill", {
      id: "stale-skill", expected_content: "# Before", content: "# Proposed",
    });

    writeSkill("stale-skill", "# Concurrent edit");
    const action = getPendingAction(queued.proposal_id)!;
    expect(await applyAction(action.kind, JSON.parse(action.payload))).toMatchObject({ ok: false });
    expect(getSkill("stale-skill")?.content).toBe("# Concurrent edit");
  });

  it("does not redirect an approved skill write after the writable repository changes", async () => {
    const queued = await propose("write_skill", {
      id: "pinned-repository", expected_content: null, content: "# Proposed",
    });
    const replacement = createSkillRepo({ path: join(root, "other-skills"), writable: true });
    try {
      const action = getPendingAction(queued.proposal_id)!;
      const result = await applyAction(action.kind, JSON.parse(action.payload));
      expect(result).toMatchObject({ ok: false, detail: expect.stringContaining("repository changed") });
      expect(getSkill("pinned-repository")).toBeNull();
    } finally {
      updateSkillRepo(replacement.id, { writable: false });
      updateSkillRepo(repo.id, { writable: true });
    }
  });

  it("changes only the scheduled prompt and preserves schedule, target and enabled state", async () => {
    const before = createScheduledTask({
      agent_id: "artifact-agent", prompt: "Before", kind: "cron", schedule: "0 9 * * *", silent: true,
    });
    const queued = await propose("update_scheduled_task_prompt", {
      id: before.id, expected_content: before.prompt, content: "After",
    });
    expect(getScheduledTask(before.id)).toEqual(before);
    const action = getPendingAction(queued.proposal_id)!;
    expect(await applyAction(action.kind, JSON.parse(action.payload))).toMatchObject({ ok: true });
    expect(getScheduledTask(before.id)).toMatchObject({
      prompt: "After", schedule: before.schedule, next_run_at: before.next_run_at,
      agent_id: before.agent_id, enabled: before.enabled, silent: before.silent,
      reaction_kind: before.reaction_kind,
    });
  });

  it("changes an unset watcher directive without altering polling or tool configuration", async () => {
    const before = createWatcher({
      agent_id: "artifact-agent", label: "Synthetic watcher", tool_name: "test_read",
      tool_args: { key: "example" }, interval_seconds: 300,
    });
    const queued = await propose("update_watcher_prompt", {
      id: before.id, expected_content: null, content: "Use the new parameter name.",
    });
    expect(getWatcher(before.id)).toEqual(before);
    const action = getPendingAction(queued.proposal_id)!;
    expect(await applyAction(action.kind, JSON.parse(action.payload))).toMatchObject({ ok: true });
    expect(getWatcher(before.id)).toMatchObject({
      reaction_prompt: "Use the new parameter name.", tool_name: before.tool_name,
      tool_args: before.tool_args, interval_seconds: before.interval_seconds,
      next_run_at: before.next_run_at, enabled: before.enabled, agent_id: before.agent_id,
    });
  });

  it("rejects stale task and watcher proposals at approval time", async () => {
    const task = createScheduledTask({ agent_id: "artifact-agent", prompt: "Before", kind: "cron", schedule: "0 9 * * *" });
    const watcher = createWatcher({ agent_id: "artifact-agent", label: "Stale", tool_name: "test_read", interval_seconds: 300 });
    const cases = [
      { kind: "update_scheduled_task_prompt" as const, id: task.id, expected_content: "Before" },
      { kind: "update_watcher_prompt" as const, id: watcher.id, expected_content: null },
    ];
    for (const { kind, id, expected_content } of cases) {
      const queued = await propose(kind, { id, expected_content, content: "Proposed" });
      if (kind === "update_scheduled_task_prompt") updateScheduledTask(id, { prompt: "Concurrent" });
      else updateWatcher(id, { reaction_prompt: "Concurrent" });
      const action = getPendingAction(queued.proposal_id)!;
      expect(await applyAction(kind, JSON.parse(action.payload))).toMatchObject({ ok: false });
    }
    expect(getScheduledTask(task.id)?.prompt).toBe("Concurrent");
    expect(getWatcher(watcher.id)?.reaction_prompt).toBe("Concurrent");
  });

  it.each([
    { id: "../escape", expected_content: null, content: "# Unsafe path" },
    { id: "missing-baseline", content: "# Missing" },
    { id: "blank", expected_content: null, content: " \n " },
    { id: "extra-field", expected_content: null, content: "# Valid", schedule: "* * * * *" },
  ])("rejects invalid skill payloads before creating approval records: $id", async (payload) => {
    expect(await propose("write_skill", payload)).toMatchObject({ error_code: "invalid_proposal_payload" });
    expect(await applyAction("write_skill", payload)).toMatchObject({ ok: false });
  });

  it("rejects missing resources, oversized watcher prompts and script tasks", () => {
    expect(validateArtifactProposal("update_scheduled_task_prompt", { id: "absent", expected_content: "", content: "After" })).toContain("not found");
    const watcher = createWatcher({ agent_id: "artifact-agent", label: "Bounded", tool_name: "test_read", interval_seconds: 300 });
    expect(validateArtifactProposal("update_watcher_prompt", { id: watcher.id, expected_content: null, content: "x".repeat(4001) })).toContain("4000");
    const task = createScheduledTask({
      agent_id: "artifact-agent", kind: "cron", schedule: "0 9 * * *",
      reaction_kind: "script", reaction_script: "reaction.test",
    });
    expect(validateArtifactProposal("update_scheduled_task_prompt", { id: task.id, expected_content: "", content: "After" })).toContain("script task");
  });
});
