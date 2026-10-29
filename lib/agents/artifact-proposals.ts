import { z } from "zod";
import { getSkill, getSkillsDir, writeSkill } from "@/lib/skills";
import { getScheduledTask, updateScheduledTask } from "@/lib/stores/scheduled-tasks";
import { getWatcher, updateWatcher } from "@/lib/stores/watchers";
import { errorMessage } from "@/lib/utils/error";
import { getWritableSkillRepo } from "@/lib/stores/skill-repos";

export const artifactProposalKinds = [
  "write_skill",
  "update_scheduled_task_prompt",
  "update_watcher_prompt",
] as const;

export type ArtifactProposalKind = typeof artifactProposalKinds[number];

const artifactPayload = z.object({
  id: z.string().min(1),
  expected_content: z.string().nullable(),
  content: z.string().refine((value) => value.trim().length > 0, "content must not be blank"),
  writable_repo_id: z.string().optional(),
}).strict();

export function isArtifactProposalKind(kind: string): kind is ArtifactProposalKind {
  return artifactProposalKinds.some((value) => value === kind);
}

export function validateArtifactProposal(kind: ArtifactProposalKind, payload: unknown): string | null {
  const parsed = artifactPayload.safeParse(payload);
  if (!parsed.success) return parsed.error.message;
  const { id, expected_content, content, writable_repo_id } = parsed.data;
  if (kind === "write_skill") {
    if (!/^[\p{L}\p{N}\p{M}_-]+$/u.test(id)) return "Invalid skill ID";
    if (!getSkillsDir()) return "No writable skill repo is configured";
    if (writable_repo_id !== undefined && writable_repo_id !== getWritableSkillRepo()?.id) {
      return "Writable skill repository changed; create a new proposal";
    }
    if ((getSkill(id)?.content ?? null) !== expected_content) return "Skill content changed; read it again and create a new proposal";
    return null;
  }
  if (kind === "update_scheduled_task_prompt") {
    const task = getScheduledTask(id);
    if (!task) return "Scheduled task not found";
    if (task.reaction_kind !== "agent_prompt") return "Cannot edit the prompt of a script task";
    return task.prompt === expected_content ? null : "Task prompt changed; read it again and create a new proposal";
  }
  const watcher = getWatcher(id);
  if (!watcher) return "Watcher not found";
  if (watcher.reaction_kind !== "agent_prompt") return "Cannot edit the prompt of a script watcher";
  if (content.length > 4000) return "Watcher prompt must not exceed 4000 characters";
  if (content !== content.trim()) return "Watcher prompt must not have leading or trailing whitespace";
  return watcher.reaction_prompt === expected_content ? null : "Watcher prompt changed; read it again and create a new proposal";
}

export function prepareArtifactProposal(kind: ArtifactProposalKind, payload: Record<string, unknown>) {
  return kind === "write_skill"
    ? { ...payload, writable_repo_id: getWritableSkillRepo()?.id }
    : payload;
}

export function applyArtifactProposal(
  kind: ArtifactProposalKind,
  payload: unknown,
): { ok: boolean; detail: unknown } {
  const error = validateArtifactProposal(kind, payload);
  if (error) return { ok: false, detail: error };
  if (kind === "write_skill" && !artifactPayload.parse(payload).writable_repo_id) {
    return { ok: false, detail: "Skill proposal is missing its writable repository; create a new proposal" };
  }
  const { id, content } = artifactPayload.parse(payload);
  try {
    if (kind === "write_skill") {
      writeSkill(id, content);
      if (getSkill(id)?.content !== content) throw new Error("Skill read-back did not match approved content");
    } else if (kind === "update_scheduled_task_prompt") {
      const task = updateScheduledTask(id, { prompt: content });
      if (task?.prompt !== content) throw new Error("Task read-back did not match approved content");
    } else {
      const watcher = updateWatcher(id, { reaction_prompt: content });
      if (watcher?.reaction_prompt !== content) throw new Error("Watcher read-back did not match approved content");
    }
    return { ok: true, detail: { id } };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}
