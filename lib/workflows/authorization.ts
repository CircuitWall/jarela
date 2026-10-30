import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { SkillExecutionArtifact } from "@/lib/skills/execution-artifact";
import { skillInvocationDigest, SKILL_CONSENT_TTL_MS } from "@/lib/skills/execution-consent";
import { resolveSkill } from "@/lib/skills";
import { createPendingAction } from "@/lib/stores/pending-actions";
import { parseWorkflowDefinition } from "./definition";
import { validateSkillInvocation } from "@/lib/skills/execution-protocol";

type Plan = {
  id: string; runId: string; agentId: string; workspace: string; definitionText: string; invocationJson: string;
  revision: string; invocationDigest: string; deadline: number; expiresAt: number;
  workspaceIdentity: string;
  status: "pending" | "approved"; proposalId: string;
  scripts: Map<string, { skillId: string; artifact: SkillExecutionArtifact; consumed: boolean }>;
};
const KEY = Symbol.for("@jarela/workflow-execution-grants");
type GlobalPlans = typeof globalThis & { [KEY]?: Map<string, Plan> };
function plans(): Map<string, Plan> { return (globalThis as GlobalPlans)[KEY] ??= new Map<string, Plan>(); }
function workspaceIdentity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error("Workflow workspace must be canonical and unlinked");
  return `${stat.dev}:${stat.ino}`;
}
function expire() {
  for (const [id, plan] of plans()) if (performance.now() >= plan.deadline) plans().delete(id);
}
export function workflowSkillId(action: string) {
  return action === "plan_memory_cleanup" ? "memory-organization" : action;
}
export function requestWorkflowAuthorization(input: {
  runId: string; agentId: string; workspace: string; definitionText: string; invocationJson: string;
}) {
  expire();
  const definition = parseWorkflowDefinition(input.definitionText);
  validateSkillInvocation(definition.inputContract, input.invocationJson);
  const invocationDigest = skillInvocationDigest(input.invocationJson);
  const existing = [...plans().values()].find((plan) => plan.runId === input.runId
    && plan.agentId === input.agentId && plan.workspace === input.workspace
    && plan.revision === definition.revision && plan.invocationDigest === invocationDigest);
  if (existing) return { status: existing.status, proposal_id: existing.proposalId, authorization_id: existing.id };
  if (plans().size >= 16) throw new Error("Workflow approval capacity reached");
  const capturedWorkspace = workspaceIdentity(input.workspace);
  const scripts: Plan["scripts"] = new Map();
  let totalBytes = 0;
  const retainedBytes = [...plans().values()].reduce((total, plan) => total
    + [...plan.scripts.values()].reduce((bytes, script) => bytes + script.artifact.totalBytes, 0), 0);
  for (const step of definition.steps) {
    if (step.kind !== "script") continue;
    const skillId = workflowSkillId(step.action);
    const resolved = resolveSkill(skillId);
    if (!resolved?.directory) throw new Error(`Workflow script action must be an executable skill ID: ${step.action}`);
    const artifact = SkillExecutionArtifact.capture(resolved.directory);
    totalBytes += artifact.totalBytes;
    if (totalBytes > 16 * 1024 * 1024 || retainedBytes + totalBytes > 64 * 1024 * 1024) {
      throw new Error("Workflow executable snapshot capacity exceeded");
    }
    scripts.set(step.id, { skillId, artifact, consumed: false });
  }
  if (!scripts.size) return { status: "approved" as const, proposal_id: null, authorization_id: null };
  const id = randomUUID();
  const plan: Plan = { ...input, id, revision: definition.revision, invocationDigest, scripts, workspaceIdentity: capturedWorkspace,
    deadline: performance.now() + SKILL_CONSENT_TTL_MS, expiresAt: Date.now() + SKILL_CONSENT_TTL_MS,
    status: "pending", proposalId: "" };
  plan.proposalId = createPendingAction({
    agent_id: input.agentId, kind: "execute_workflow",
    payload: { authorization_id: id, workflow_run_id: input.runId, workflow_revision: definition.revision,
      workspace: input.workspace, invocation_digest: invocationDigest,
      scripts: [...scripts].map(([stepId, script]) => ({ step_id: stepId, skill_id: script.skillId, artifact_revision: script.artifact.revision })),
      expires_at: new Date(plan.expiresAt).toISOString(), full_trust: true },
    reason: "Approve only the declared script steps of this bounded workflow run; choices are not execution consent",
  }).id;
  plans().set(id, plan);
  return { status: "pending" as const, proposal_id: plan.proposalId, authorization_id: id };
}
function getPlan(id: string) {
  expire();
  const plan = plans().get(id);
  if (!plan) throw new Error("Workflow execution authorization expired or belongs to a previous app instance");
  return plan;
}
export function inspectWorkflowAuthorization(id: string) {
  const plan = getPlan(id);
  return {
    input_json: plan.invocationJson, definition_json: plan.definitionText,
    artifact_revision: plan.revision, workspace: plan.workspace, runtime_version: process.version,
    timeout_ms: parseWorkflowDefinition(plan.definitionText).steps.reduce((total, step) => total + step.timeoutMs * step.maxAttempts, 0),
    max_output_bytes: [...plan.scripts.values()].reduce((total, script) => total + script.artifact.getManifest().maxOutputBytes, 0),
    expires_at: new Date(plan.expiresAt).toISOString(),
    files: [...plan.scripts].flatMap(([stepId, script]) => script.artifact.files.map((file) => ({
      ...file, path: `${stepId}/${file.path}`, base64: script.artifact.readFile(file.path).toString("base64"),
    }))),
  };
}
export function approveWorkflowAuthorization(id: string) {
  const plan = getPlan(id);
  if (plan.status !== "pending") throw new Error("Workflow authorization already decided");
  if (workspaceIdentity(plan.workspace) !== plan.workspaceIdentity) {
    plans().delete(id); throw new Error("Workflow workspace changed; request fresh approval");
  }
  for (const script of plan.scripts.values()) {
    const resolved = resolveSkill(script.skillId);
    if (!resolved?.directory || SkillExecutionArtifact.capture(resolved.directory).revision !== script.artifact.revision) {
      plans().delete(id); throw new Error("Workflow script source changed; request fresh approval");
    }
  }
  plan.status = "approved";
  return { workflow_run_id: plan.runId, authorized: true, message: "Plan approved; resume the workflow explicitly. Typed choices do not authorize scripts." };
}
export function consumeWorkflowScriptAuthorization(input: {
  runId: string; agentId: string; workspace: string; revision: string; invocationJson: string;
  stepId: string; skillId: string; artifactRevision: string;
}) {
  expire();
  const plan = [...plans().values()].find((candidate) => candidate.runId === input.runId && candidate.agentId === input.agentId
    && candidate.workspace === input.workspace && candidate.revision === input.revision
    && candidate.invocationDigest === skillInvocationDigest(input.invocationJson) && candidate.status === "approved");
  const script = plan?.scripts.get(input.stepId);
  if (!plan || !script || script.consumed || script.skillId !== input.skillId || script.artifact.revision !== input.artifactRevision) {
    throw new Error("Missing or consumed workflow script authorization; request fresh plan approval");
  }
  if (workspaceIdentity(input.workspace) !== plan.workspaceIdentity) {
    plans().delete(plan.id); throw new Error("Workflow workspace changed; request fresh approval");
  }
  script.consumed = true;
}
export function revokeWorkflowAuthorizations(runId: string) {
  for (const [id, plan] of plans()) if (plan.runId === runId) plans().delete(id);
}
