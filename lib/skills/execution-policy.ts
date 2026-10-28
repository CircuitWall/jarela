import { z } from "zod";
import type { SafetyMode } from "@/lib/tools/security/safety";

export const SKILL_EXECUTION_POLICY_KEY = "skill_execution_policy";
export function isSkillExecutionPolicySetting(namespace: string, key: string): boolean {
  return namespace === "app-settings" && key === SKILL_EXECUTION_POLICY_KEY;
}

const identity = z.string().min(1).max(240).refine((value) => value === value.trim(), "Remove surrounding whitespace");
export const SkillRevisionTrustSchema = z.strictObject({
  revision: z.string().regex(/^[a-f0-9]{64}$/, "Revision must be a SHA-256 digest"),
  agent_id: identity,
  workspace: z.string().min(1).max(4096),
  max_timeout_ms: z.number().int().min(1000).max(120_000),
  max_output_bytes: z.number().int().min(1).max(256 * 1024),
});
export const SkillExecutionPolicySchema = z.strictObject({
  mode: z.enum(["blocked", "ask_each_time", "approve_workflow", "trusted_revisions"]),
  trusted_revisions: z.array(SkillRevisionTrustSchema).max(64),
}).superRefine((policy, ctx) => {
  const keys = policy.trusted_revisions.map((grant) => JSON.stringify([grant.revision, grant.agent_id, grant.workspace]));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["trusted_revisions"], message: "Duplicate revision trust scope" });
});
export type SkillRevisionTrust = z.infer<typeof SkillRevisionTrustSchema>;
export type SkillExecutionPolicy = z.infer<typeof SkillExecutionPolicySchema>;

export function defaultSkillExecutionPolicy(): SkillExecutionPolicy {
  return { mode: "ask_each_time", trusted_revisions: [] };
}

export const SkillExecutionTargetSchema = z.strictObject({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  agent_id: identity,
  workspace: z.string().min(1).max(4096),
  timeout_ms: z.number().int().min(1000).max(120_000),
  max_output_bytes: z.number().int().min(1).max(256 * 1024),
});
export type SkillExecutionTarget = z.infer<typeof SkillExecutionTargetSchema>;
export type SkillExecutionPolicyDecision =
  | { kind: "blocked"; reason: string }
  | { kind: "require_invocation_consent" }
  | { kind: "require_workflow_consent" }
  | { kind: "trusted_revision" };

// This resolves consent requirements only. The runner must independently verify
// snapshot/workspace identity, validate I/O, and enforce capability and limits.
export function evaluateSkillExecutionPolicy(
  policy: SkillExecutionPolicy, target: SkillExecutionTarget,
  context: { safetyMode: SafetyMode; executeAllowed: boolean },
): SkillExecutionPolicyDecision {
  const checkedPolicy = SkillExecutionPolicySchema.parse(policy);
  const checkedTarget = SkillExecutionTargetSchema.parse(target);
  if (!["safe", "mostly_safe", "bypass"].includes(context.safetyMode)) {
    return { kind: "blocked", reason: "Unknown safety mode" };
  }
  if (context.safetyMode === "safe") return { kind: "blocked", reason: "Safe mode blocks skill scripts" };
  if (context.executeAllowed !== true) return { kind: "blocked", reason: "Execute capability is required" };
  if (checkedPolicy.mode === "blocked") return { kind: "blocked", reason: "Skill execution is blocked in Security settings" };
  if (checkedPolicy.mode === "approve_workflow") return { kind: "require_workflow_consent" };
  if (checkedPolicy.mode === "trusted_revisions" && checkedPolicy.trusted_revisions.some((grant) =>
    grant.revision === checkedTarget.revision && grant.agent_id === checkedTarget.agent_id
    && grant.workspace === checkedTarget.workspace && checkedTarget.timeout_ms <= grant.max_timeout_ms
    && checkedTarget.max_output_bytes <= grant.max_output_bytes)) {
    return { kind: "trusted_revision" };
  }
  return { kind: "require_invocation_consent" };
}
